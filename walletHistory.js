import Web3 from "web3";
import PQueue from "p-queue";

const RPCS = [
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed1.defibit.io/"
];

let rpcIndex = 0;
function getWeb3() {
  return new Web3(RPCS[rpcIndex]);
}
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return getWeb3();
}

const queue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 4 });

// ---------------- SAFE CALL ----------------
async function safeCall(fn) {
  let web3 = getWeb3();
  try {
    return await fn(web3);
  } catch {
    web3 = rotateRpc();
    return await fn(web3);
  }
}

// ---------------- DEV WALLET (FAST) ----------------
async function getDevWallet(tokenAddress) {
  return queue.add(async () =>
    safeCall(async (web3) => {
      const latest = await web3.eth.getBlockNumber();
      const LOOKBACK = 30_000; // ~1 day BSC

      for (let b = latest; b >= Math.max(latest - LOOKBACK, 0); b--) {
        const block = await web3.eth.getBlock(b, true);
        if (!block?.transactions) continue;

        for (const tx of block.transactions) {
          if (tx.creates?.toLowerCase() === tokenAddress.toLowerCase()) {
            return tx.from.toLowerCase();
          }
        }
      }

      throw new Error("Dev wallet not found (recent blocks)");
    })
  );
}

// ---------------- WALLET AGE (FAST) ----------------
async function getWalletAgeMinutes(dev) {
  return queue.add(async () =>
    safeCall(async (web3) => {
      const latest = await web3.eth.getBlockNumber();
      const STEP = 2_000;

      for (let from = latest; from > 0; from -= STEP) {
        for (let b = from; b >= Math.max(from - STEP, 0); b--) {
          const block = await web3.eth.getBlock(b, true);
          if (!block?.transactions) continue;

          for (const tx of block.transactions) {
            if (
              tx.from?.toLowerCase() === dev ||
              tx.to?.toLowerCase() === dev
            ) {
              return (Date.now() / 1000 - block.timestamp) / 60;
            }
          }
        }
      }

      return Infinity;
    })
  );
}

// ---------------- PUBLIC API ----------------
export async function walletRate(tokenAddress) {
  const dev = await getDevWallet(tokenAddress);
  const ageMinutes = await getWalletAgeMinutes(dev);

  let health = "unhealthy";
  if (ageMinutes >= 10_080) health = "healthy"; // ≥7 days

  return {
    token: tokenAddress,
    dev,
    walletAgeMinutes: Math.round(ageMinutes),
    health
  };
}