import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import PQueue from "p-queue";

/* ================= RPC ================= */
const RPCS = [process.env.RPC_URL_8, process.env.RPC_URL_9].filter(Boolean);
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
      throw e1; // return original error
    }
  }
}

/* ================= ENV ADDRESSES ================= */
function mustAddress(name, value) {
  if (!value || typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`${name} missing or invalid in .env`);
  }
  return value.toLowerCase();
}

const WBNB    = mustAddress("WBNB_ADDRESS", process.env.WBNB_ADDRESS);
const ROUTER  = mustAddress("PANCAKE_ROUTER", process.env.PANCAKE_ROUTER);
const FACTORY = mustAddress("PANCAKE_FACTORY", process.env.PANCAKE_FACTORY);

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
const devMemory = {}; // { dev: { deploys: number, rugs: number } }

/* ================= DEV WALLET ================= */
export async function getDevWallet(token) {
  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = await web3.eth.getBlockNumber();
      const LOOKBACK = 28800n * 3n;
      const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0n;
      const TRANSFER_TOPIC =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const ZERO_TOPIC =
        "0x0000000000000000000000000000000000000000000000000000000000000000";

      let logs = [];
      try {
        logs = await web3.eth.getPastLogs({
          fromBlock: fromBlock.toString(),
          toBlock: "latest",
          address: token,
          topics: [TRANSFER_TOPIC]
        });
      } catch {}

      if (!logs.length) return null;

      // Prefer mint
      const mintLog = logs.find(l => l.topics[1] === ZERO_TOPIC);
      if (mintLog) {
        const dev = "0x" + mintLog.topics[2].slice(26);
        return dev.toLowerCase();
      }

      // Fallback earliest transfer
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      const first = logs[0];
      return "0x" + first.topics[1].slice(26);
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
        [amountIn, "0", [token, WBNB], to, Math.floor(Date.now() / 1000) + 60]
      );
      const data = methodSig + params.slice(2);

      try {
        await web3.eth.call({ from, to: router, data });
        return { sellable: true };
      } catch (e) {
        return { sellable: false, reason: e?.message?.slice(0, 120) || "SELL_REVERT" };
      }
    })
  );
}

/* ================= LP OWNER CONTROL ================= */
export async function checkLpOwner(token) {
  const web3 = getWeb3();
  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);

  // 1️⃣ Get LP pair
  const pair = await factory.methods.getPair(token, WBNB).call();
  if (!pair || pair === "0x0000000000000000000000000000000000000000") {
    return { lpExists: false, reason: "NO_PAIR" };
  }

  const lpContract = new web3.eth.Contract(ERC20_ABI, pair);

  // 2️⃣ Find dev wallet
  const dev = await getDevWallet(token);
  if (!dev) return { lpExists: true, controlled: false, reason: "NO_DEV_INFO" };

  // 3️⃣ Check if dev holds LP now
  const balance = await lpContract.methods.balanceOf(dev).call();
  let controlled = BigInt(balance) > 0n;

  // 4️⃣ Check LP transfer history after mint
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const logs = await web3.eth.getPastLogs({ address: pair, fromBlock: 0, toBlock: "latest", topics: [TRANSFER] });

  const mintLog = logs.find(l => l.topics[1] === ZERO);
  if (!mintLog) return { lpExists: true, controlled, reason: "NO_MINT_EVENT" };

  const mintedTo = "0x" + mintLog.topics[2].slice(26).toLowerCase();
  let movedAfterMint = false;
  let currentOwner = mintedTo;

  for (const log of logs) {
    if (log.blockNumber < mintLog.blockNumber) continue;
    const from = "0x" + log.topics[1].slice(26).toLowerCase();
    const to = "0x" + log.topics[2].slice(26).toLowerCase();

    if (from === currentOwner && to !== currentOwner) {
      movedAfterMint = true;
      currentOwner = to;
    }
  }

  // 5️⃣ Determine control
  if (movedAfterMint || currentOwner !== dev) controlled = false;

  return {
    lpExists: true,
    controlled,
    mintedTo,
    movedAfterMint,
    currentOwner,
    reason: controlled ? "DEV_STILL_CONTROLS_LP" : "LP_SAFE"
  };
}
/* ================= WALLET RATE ================= */
export async function walletRate(token, testWallet) {
  const result = {
    token,
    totalScore: 0,
    health: "unhealthy",
    details: {
      sellSimulation: { score: 0, status: "unhealthy" },
      lpOwnership: { score: 0, status: "unhealthy" },
      devWallet: { score: 0, status: "unhealthy" }
    }
  };

  // 1️⃣ Sell simulation (20 points)
  const sell = await simulateRealSell({ token, router: ROUTER, from: testWallet, to: testWallet, amountIn: "1000000000000000" });
  if (sell.sellable) {
    result.details.sellSimulation.score = 20;
    result.details.sellSimulation.status = "healthy";
    result.totalScore += 20;
  }

  // 2️⃣ LP ownership (15 points)
  try {
    const lp = await checkLpOwner(token);
    if (lp.lpExists && !lp.controlled) {
      result.details.lpOwnership.score = 15;
      result.details.lpOwnership.status = "healthy";
      result.totalScore += 15;
    }
  } catch {}

  // 3️⃣ Dev wallet (10 points)
  try {
    const dev = await getDevWallet(token);
    if (dev) {
      const mem = devMemory[dev] || { deploys: 0, rugs: 0 };
      const devScore = mem.rugs === 0 ? 10 : 0;
      result.details.devWallet.score = devScore;
      if (devScore > 0) result.details.devWallet.status = "healthy";
      result.totalScore += devScore;
    }
  } catch {}

  // Final health threshold > 33
  if (result.totalScore > 33) result.health = "healthy";

  return result;
}