import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs provided");

let activeRpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

function rotateRpc() {
  activeRpcIndex = (activeRpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);
  console.log(`➡️ Switched RPC → ${RPC_URLS[activeRpcIndex]}`);
}

const queue = new PQueue({
  interval: 3000,
  intervalCap: 4,
  concurrency: 1,
});

async function withRpcFailover(fn) {
  let lastError;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await queue.add(() => fn(provider));
    } catch (err) {
      console.warn(`⚠️ RPC failed (${RPC_URLS[activeRpcIndex]}): ${err.message}`);
      lastError = err;
      rotateRpc();
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

/* ================= CONSTANTS ================= */
const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dead";
const ERC20_ABI = ["function totalSupply() view returns(uint256)"];
const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const PANCAKE_ROUTER = process.env.PANCAKE_ROUTER || "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"
];

// ---------------- HELPERS ----------------
const isEOA = async (addr) => {
  const code = await provider.getCode(addr);
  return code === "0x";
};

async function topHolderConcentrationCheck(tokenAddress, maxPct = 0.13, scanBlocks = 20_000) {
  return withRpcFailover(async (prov) => {
    const ERC20_FULL_ABI = [
      "function totalSupply() view returns(uint256)",
      "event Transfer(address indexed from, address indexed to, uint256 value)"
    ];
    const token = new ethers.Contract(tokenAddress, ERC20_FULL_ABI, prov);

    const latest = await prov.getBlockNumber();
    const fromBlock = Math.max(0, latest - scanBlocks);

    const logs = await prov.getLogs({
      address: tokenAddress,
      fromBlock,
      toBlock: latest,
      topics: [TRANSFER_TOPIC]
    });

    if (!logs.length) return false;

    const balances = new Map();
    for (const log of logs) {
      const from = "0x" + log.topics[1].slice(26).toLowerCase();
      const to   = "0x" + log.topics[2].slice(26).toLowerCase();
      const val  = BigInt(log.data);

      if (![ZERO, DEAD].includes(from)) balances.set(from, (balances.get(from) || 0n) - val);
      if (![ZERO, DEAD].includes(to)) balances.set(to, (balances.get(to) || 0n) + val);
    }

    const totalSupply = BigInt(await token.totalSupply());
    const holders = [...balances.entries()].filter(([, bal]) => bal > 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 10);

    const topSum = holders.reduce((acc, [, bal]) => acc + bal, 0n);
    const pct = Number(topSum) / Number(totalSupply);

    console.log(`➡️ Top10 hold ${(pct * 100).toFixed(2)}% of supply`);
    return pct <= maxPct;
  });
}

/* ================= SWAP FEE CHECK (EXPORTED) ================= */
export async function swapFeeCheck(tokenAddress, maxFeePct = 0.10) {
  return queue.add(async () => {
    return withRpcFailover(async (prov) => {
      try {
        provider = prov; // ensure provider is set
        const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, prov);
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, prov);

        const decimals = await token.decimals();
        const amountIn = ethers.parseEther("0.01"); // simulate small swap
        const path = [WBNB, tokenAddress];

        const amountsOut = await router.getAmountsOut(amountIn, path);
        const amountOut = amountsOut[1];

        // scale amountOut by token decimals
        const scaledAmountOut = Number(amountOut) / 10 ** decimals;
        const scaledAmountIn = Number(amountIn) / 1e18; // BNB 18 decimals

        const effectiveFee = 1 - scaledAmountOut / scaledAmountIn;

        if (effectiveFee > maxFeePct) {
          console.log(`⚠️ Swap fee too high for ${tokenAddress}: ${(effectiveFee*100).toFixed(2)}%`);
          return false;
        }

        return true;
      } catch (err) {
        console.warn(`⚠️ Swap fee check failed for ${tokenAddress}: ${err.message}`);
        return false;
      }
    });
  });
}


/* ================= MARKET HEALTH PASS ================= */
export async function marketHealthPass(token) {
  return queue.add(async () => {
    return withRpcFailover(async (prov) => {
      const factory = new ethers.Contract(FACTORY, FACTORY_ABI, prov);
      const pair = await factory.getPair(token, WBNB);
      if (pair === ZERO) return false;

      const latest = await prov.getBlockNumber();
      const fromBlock = latest - 5000;

      const logs = await prov.getLogs({
        address: token,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock: latest
      });

      const buyers = new Set();
      const sellers = new Set();
      const buyBlocks = new Set();
      let soldAmount = 0n;

      for (const log of logs) {
        const from = "0x" + log.topics[1].slice(26);
        const to = "0x" + log.topics[2].slice(26);
        const amount = BigInt(log.data);

        if (from.toLowerCase() === pair.toLowerCase() && await isEOA(to)) {
          buyers.add(to.toLowerCase());
          buyBlocks.add(log.blockNumber);
        }
        if (to.toLowerCase() === pair.toLowerCase() && await isEOA(from)) {
          sellers.add(from.toLowerCase());
          soldAmount += amount;
        }
      }

      const erc = new ethers.Contract(token, ERC20_ABI, prov);
      const supply = BigInt(await erc.totalSupply());

      const pass =
        buyers.size >= 20 &&
        sellers.size >= 5 &&
        buyBlocks.size >= 20 &&
        soldAmount * 100n / supply <= 5n &&
        await topHolderConcentrationCheck(token);

      console.log("➡️ Market health:", {
        buyers: buyers.size,
        sellers: sellers.size,
        buyBlocks: buyBlocks.size,
        soldPct: Number(soldAmount * 100n / supply).toFixed(2),
        pass
      });

      return pass;
    });
  });
}