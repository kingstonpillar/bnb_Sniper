import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import PQueue from "p-queue";

/* ================= RPC FROM .ENV ================= */
const RPCS = [
  process.env.RPC_URL_8,
  process.env.RPC_URL_9
].filter(Boolean);

if (!RPCS.length) {
  throw new Error("No RPC URLs provided for walletHistory");
}

let rpcIndex = 0;
function getWeb3() {
  return new Web3(RPCS[rpcIndex]);
}
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return getWeb3();
}

/* ================= QUEUE ================= */
const queue = new PQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 2
});

async function safeCall(fn) {
  let web3 = getWeb3();
  try {
    return await fn(web3);
  } catch (err) {
    web3 = rotateRpc();
    return await fn(web3);
  }
}

/* ================= CONSTANTS ================= */
// BSC ~28,800 blocks/day → 3 days ≈ 86,400
const DEV_LOOKBACK_BLOCKS = 30_000;   // ~1 day (token creation must be recent)
const AGE_LOOKBACK_BLOCKS = 90_000;   // ~3 days wallet activity

/* ================= DEV WALLET RESOLUTION ================= */
async function getDevWallet(tokenAddress) {
  tokenAddress = tokenAddress.toLowerCase();

  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = Number(await web3.eth.getBlockNumber());
      const fromBlock = Math.max(0, latest - DEV_LOOKBACK_BLOCKS);

      for (let b = latest; b >= fromBlock; b--) {
        const block = await web3.eth.getBlock(b, true);
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          if (tx.creates && tx.creates.toLowerCase() === tokenAddress) {
            return tx.from.toLowerCase();
          }
        }
      }

      throw new Error("Dev wallet not found in recent blocks");
    })
  );
}

/* ================= WALLET AGE CHECK ================= */
async function checkWalletAge(devAddress) {
  devAddress = devAddress.toLowerCase();

  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = Number(await web3.eth.getBlockNumber());
      const fromBlock = Math.max(0, latest - AGE_LOOKBACK_BLOCKS);

      for (let b = latest; b >= fromBlock; b--) {
        const block = await web3.eth.getBlock(b, true);
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          if (
            tx.from?.toLowerCase() === devAddress ||
            tx.to?.toLowerCase() === devAddress
          ) {
            const minutes =
              (Date.now() / 1000 - block.timestamp) / 60;

            return {
              firstSeenMinutes: Math.round(minutes),
              fresh: true
            };
          }
        }
      }

      // No activity in last ~3 days
      return {
        firstSeenMinutes: null,
        fresh: false
      };
    })
  );
}

/* ================= PUBLIC API ================= */
export async function walletRate(tokenAddress) {
  const dev = await getDevWallet(tokenAddress);
  const age = await checkWalletAge(dev);

  const health = age.fresh ? "unhealthy" : "healthy";

  return [
    {
      token: tokenAddress.toLowerCase(),
      dev,
      walletAgeMinutes: age.firstSeenMinutes ?? ">3 days",
      lookbackDays: 3,
      health
    }
  ];
}