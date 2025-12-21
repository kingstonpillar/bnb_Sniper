// file: marketHealth.js
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= CONFIG ================= */
const RPC = process.env.RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC);

const queue = new PQueue({
  interval: 3000,
  intervalCap: 4,
  concurrency: 1,
});

const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dead";

const ERC20_ABI = ["function totalSupply() view returns(uint256)"];
const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/* ================= HELPERS ================= */
const isEOA = async (addr) => {
  const code = await provider.getCode(addr);
  return code === "0x";
};

/* ================= TOP 10 HOLDERS CHECK ================= */
async function topHolderConcentrationCheck(tokenAddress, maxPct = 0.13, scanBlocks = 20_000) {
  const ERC20_FULL_ABI = [
    "function totalSupply() view returns(uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
  ];
  const token = new ethers.Contract(tokenAddress, ERC20_FULL_ABI, provider);

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - scanBlocks);

  const logs = await provider.getLogs({
    address: tokenAddress,
    fromBlock,
    toBlock: latest,
    topics: [TRANSFER_TOPIC]
  });

  if (!logs.length) return false; // suspicious: no activity

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

  console.log(`👥 Top10 hold ${(pct * 100).toFixed(2)}% of supply`);
  return pct <= maxPct; // true = SAFE
}

.async function swapFeeCheck(tokenAddress, maxFeePct = 0.10) {
  const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, provider);

  const logs = await provider.getLogs({
    address: PANCAKE_ROUTER,
    fromBlock: 0,
    toBlock: "latest"
  });

  let buyers = new Set();
  for (const log of logs) {
    let parsed;
    try { parsed = router.interface.parseLog(log); } catch { continue; }

    if (
      parsed.name === "SwapExactETHForTokens" ||
      parsed.name === "SwapExactETHForTokensSupportingFeeOnTransferTokens"
    ) {
      const path = parsed.args.path;
      const to = parsed.args.to.toLowerCase();

      if (path[0].toLowerCase() === WBNB.toLowerCase() && path[path.length - 1].toLowerCase() === tokenAddress.toLowerCase()) {
        const amountIn = parsed.args.amountIn || ethers.parseEther("0");
        const amountOut = parsed.args.amountOut;
        const effectiveFee = 1 - Number(amountOut) / Number(amountIn);

        if (effectiveFee > maxFeePct) {
          console.log(` Swap fee too high for ${tokenAddress}: ${(effectiveFee*100).toFixed(2)}%`);
          return false; // fail condition
        }

        buyers.add(to);
        if (buyers.size >= 20) break;
      }
    }
  }

  return true; // pass if no high fee detected
}


================= */
/* ================= UPDATED marketHealthPass ================= */
export async function marketHealthPass(token) {
  return queue.add(async () => {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const pair = await factory.getPair(token, WBNB);
    if (pair === ZERO) return false;

    const latest = await provider.getBlockNumber();
    const fromBlock = latest - 5000;

    const logs = await provider.getLogs({
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

    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    const supply = BigInt(await erc.totalSupply());

    const feeCheck = await swapFeeCheck(token); // 5th condition

    const pass =
      buyers.size >= 20 &&
      sellers.size >= 5 &&
      buyBlocks.size >= 20 &&
      soldAmount * 100n / supply <= 5n &&
      await topHolderConcentrationCheck(token) &&
      feeCheck; // NEW 5TH CONDITION

    console.log(" Market health:", {
      buyers: buyers.size,
      sellers: sellers.size,
      buyBlocks: buyBlocks.size,
      soldPct: Number(soldAmount * 100n / supply).toFixed(2),
      feePass: feeCheck,
      pass
    });

    return pass;
  });
}