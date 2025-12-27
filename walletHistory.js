import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import PQueue from "p-queue";

/* ================= RPC ================= */
const RPCS = [
  process.env.RPC_URL_8,
  process.env.RPC_URL_9
].filter(Boolean);

if (!RPCS.length) throw new Error("No RPC URLs configured");

let rpcIndex = 0;
function getWeb3() {
  return new Web3(RPCS[rpcIndex]);
}
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return getWeb3();
}

const queue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 5 });

async function safeCall(fn) {
  let web3 = getWeb3();
  try {
    return await fn(web3);
  } catch (e1) {
    try {
      web3 = rotateRpc();
      return await fn(web3);
    } catch (e2) {
      throw e1; // surface original error
    }
  }
}

/* ================= ABIs ================= */
const FACTORY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" }
    ],
    name: "getPair",
    outputs: [{ internalType: "address", name: "pair", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function"
  }
];

/* ================= RUG MEMORY ================= */
const devMemory = {};
// { dev: { deploys: number, rugs: number } }

/* ================= DEV WALLET (LOG BASED) ================= */
async function getDevWallet(token) {
  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = Number(await web3.eth.getBlockNumber());
      const fromBlock = Math.max(0, latest - 28800 * 3);

      const TRANSFER_TOPIC =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      const ZERO_TOPIC =
        "0x0000000000000000000000000000000000000000000000000000000000000000";

      const IGNORE = new Set([
        process.env.WBNB_ADDRESS.toLowerCase(),
        "0x000000000000000000000000000000000000dead"
      ]);

      let logs;
      try {
        logs = await web3.eth.getPastLogs({
          fromBlock,
          toBlock: "latest",
          address: token,
          topics: [TRANSFER_TOPIC]
        });
      } catch {
        logs = await web3.eth.getPastLogs({
          fromBlock: latest - 5000,
          toBlock: "latest",
          address: token,
          topics: [TRANSFER_TOPIC]
        });
      }

      if (!logs.length) {
        throw new Error("No transfer logs → cannot infer dev");
      }

      // 1️⃣ Prefer mint event (from = 0x0)
      const mintLog = logs.find(l => l.topics[1] === ZERO_TOPIC);
      if (mintLog) {
        const dev = "0x" + mintLog.topics[2].slice(26);
        const devLower = dev.toLowerCase();
        if (IGNORE.has(devLower)) throw new Error("Minted to non-dev address");
        return devLower;
      }

      // 2️⃣ Fallback: earliest transfer
      logs.sort((a, b) =>
        a.blockNumber !== b.blockNumber
          ? a.blockNumber - b.blockNumber
          : a.logIndex - b.logIndex
      );

      const first = logs[0];
      const dev = "0x" + first.topics[1].slice(26);
      const devLower = dev.toLowerCase();
      if (IGNORE.has(devLower)) throw new Error("Minted to non-dev address");

      return devLower;
    })
  );
}

/* ================= SELL SIMULATION ================= */
async function simulateRealSell({ token, router, from, to, amountIn }) {
  return queue.add(() =>
    safeCall(async (web3) => {
      const methodSig = web3.eth.abi.encodeFunctionSignature(
        "swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"
      );

      const params = web3.eth.abi.encodeParameters(
        ["uint256", "uint256", "address[]", "address", "uint256"],
        [
          amountIn,
          "0",
          [token, process.env.WBNB_ADDRESS],
          to,
          Math.floor(Date.now() / 1000) + 60
        ]
      );

      const data = methodSig + params.slice(2);

      try {
        await web3.eth.call({ from, to: router, data });
        return { sellable: true };
      } catch (e) {
        return {
          sellable: false,
          reason: e?.message?.slice(0, 120) || "SELL_REVERT"
        };
      }
    })
  );
}

/* ================= SCORING ================= */
function deployScore(dev) {
  const mem = devMemory[dev] || { deploys: 1, rugs: 0 };
  if (mem.rugs === 0) return Math.min(25, mem.deploys * 5);
  if (mem.rugs === 1) return Math.min(10, mem.deploys * 2);
  return 0;
}

/* ================= PUBLIC API ================= */
export async function walletRate(token, router, testWallet, factoryAddress) {
  const dev = await getDevWallet(token);

  devMemory[dev] = devMemory[dev] || { deploys: 0, rugs: 0 };
  devMemory[dev].deploys++;

  const baseScore = deployScore(dev);

  // LP ownership check
  const lpOwned = await queue.add(() =>
    safeCall(async (web3) => {
      const factory = new web3.eth.Contract(FACTORY_ABI, factoryAddress);
      const lpAddress = await factory.methods
        .getPair(token, process.env.WBNB_ADDRESS)
        .call();

      if (!lpAddress || lpAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("LP not created");
      }

      const lpContract = new web3.eth.Contract(ERC20_ABI, lpAddress);
      const balance = await lpContract.methods.balanceOf(dev).call();
      return BigInt(balance) > 0n; // true = dev controls LP
    })
  );

  // Simulate a test sell
  const sellTest = await simulateRealSell({
    token,
    router,
    amountIn: "1000000000000000",
    from: testWallet,
    to: testWallet
  });

  // Final score and health
  const finalScore = lpOwned ? 0 : baseScore;
  const health =
    finalScore >= 20 && sellTest.sellable && !lpOwned
      ? "healthy"
      : "unhealthy";

  return [{
    token,
    dev,
    deploys: devMemory[dev].deploys,
    rugs: devMemory[dev].rugs,
    lpOwned,
    baseScore,
    score: finalScore,
    sellable: sellTest.sellable,
    sellError: sellTest.reason || null,
    health
  }];
}

/* ================= RUG MEMORY ================= */
export function markRug(dev) {
  devMemory[dev] = devMemory[dev] || { deploys: 1, rugs: 0 };
  devMemory[dev].rugs++;
}