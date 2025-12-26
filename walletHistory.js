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

const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 3 });

async function safeCall(fn) {
  let web3 = getWeb3();
  try {
    return await fn(web3);
  } catch {
    web3 = rotateRpc();
    return await fn(web3);
  }
}

/* ================= CONSTANTS ================= */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BLOCKS_PER_DAY = 28_800;
const LOOKBACK_DAYS = 3;

/* ================= RUG MEMORY ================= */
const devMemory = {}; 
// { dev: { deploys: number, rugs: number } }

/* ================= DEV WALLET ================= */
async function getDevWallet(token) {
  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = Number(await web3.eth.getBlockNumber());
      const LOOKBACK = 20_000;

      for (let b = latest; b >= latest - LOOKBACK; b--) {
        const block = await web3.eth.getBlock(b, true);
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          if (tx.creates?.toLowerCase() === token.toLowerCase()) {
            return tx.from.toLowerCase();
          }
        }
      }
      throw new Error("Dev wallet not found");
    })
  );
}

/* ================= WALLET AGE (LOG BASED) ================= */
async function getWalletAge(dev) {
  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = Number(await web3.eth.getBlockNumber());
      const fromBlock = Math.max(
        0,
        latest - BLOCKS_PER_DAY * LOOKBACK_DAYS
      );

      const logs = await web3.eth.getPastLogs({
        fromBlock,
        toBlock: "latest",
        topics: [
          TRANSFER_TOPIC,
          null,
          "0x000000000000000000000000" + dev.slice(2)
        ]
      });

      if (!logs.length) {
        return { walletAgeMinutes: `>${LOOKBACK_DAYS} days`, fresh: false };
      }

      const firstLog = logs[0];
      const block = await web3.eth.getBlock(firstLog.blockNumber);

      const minutes =
        (Date.now() / 1000 - Number(block.timestamp)) / 60;

      return { walletAgeMinutes: Math.round(minutes), fresh: true };
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
        await web3.eth.call({
          from,
          to: router,
          data
        });

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
function walletAgeMultiplier(minutes) {
  if (minutes === null || typeof minutes === "string") return 1;
  if (minutes < 1440) return 0;
  if (minutes < 10080) return 0.1;
  if (minutes < 43200) return 0.25;
  if (minutes < 129600) return 0.5;
  if (minutes < 259200) return 0.75;
  return 1.0;
}

function deployScore(dev) {
  const mem = devMemory[dev] || { deploys: 1, rugs: 0 };
  if (mem.rugs === 0) return Math.min(25, mem.deploys * 5);
  if (mem.rugs === 1) return Math.min(10, mem.deploys * 2);
  return 0;
}

/* ================= PUBLIC API ================= */
export async function walletRate(token, router, testWallet) {
  const dev = await getDevWallet(token);

  devMemory[dev] = devMemory[dev] || { deploys: 0, rugs: 0 };
  devMemory[dev].deploys++;

  const age = await getWalletAge(dev);
  const multiplier = walletAgeMultiplier(age.walletAgeMinutes);

  const baseScore = deployScore(dev);
  const finalScore = Math.round(baseScore * multiplier);

  const sellTest = await simulateRealSell({
    token,
    router,
    amountIn: "1000000000000000", // tiny test amount
    from: testWallet,
    to: testWallet
  });

  const health =
    finalScore >= 20 &&
    multiplier >= 0.5 &&
    sellTest.sellable
      ? "healthy"
      : "unhealthy";

  return [{
    token,
    dev,
    walletAgeMinutes: age.walletAgeMinutes,
    deploys: devMemory[dev].deploys,
    rugs: devMemory[dev].rugs,
    multiplier,
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