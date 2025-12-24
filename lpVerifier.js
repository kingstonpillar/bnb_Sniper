// file: lpVerifier.js
import dotenv from "dotenv";
dotenv.config(); // Load .env
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.BSC_RPC_1, process.env.BSC_RPC_2].filter(Boolean);
if (RPC_URLS.length < 1) throw new Error("At least 1 RPC required");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

// PQueue rate limiter
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });

// Rotate RPC if fails
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
}

// Wrap RPC calls with queue + retry
async function withRpc(fn) {
  let lastErr;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      lastErr = err;
      rotateRpc();
    }
  }
  throw lastErr;
}

/* ================= CONSTANTS ================= */
const WBNB_ADDRESS = process.env.WBNB_ADDRESS.toLowerCase();
const FACTORY_ADDRESS = process.env.PANCAKE_FACTORY.toLowerCase();

const LOCKERS = [
  { name: "Unicrypt", address: ethers.getAddress("0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8"), type: "time" },
  { name: "DxLocker", address: ethers.getAddress("0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21"), type: "time" },
  { name: "PinkLock", address: ethers.getAddress("0x1f546ad641b56b86fd9dceac473d1c7a357276b7"), type: "balance-only" }
];

const LOCK_ABI = ["function unlockTime() external view returns(uint256)"];
const FACTORY_ABI = ["function getPair(address tokenA,address tokenB) view returns(address)"];
const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address owner) view returns(uint256)"
];

/* ================= CACHE ================= */
const cache = {
  pairAddress: new Map(),
  totalSupply: new Map(),
};

/* ================= CORE FUNCTION ================= */
export async function verifyLP(tokenAddress, minLockSeconds = 90 * 24 * 60 * 60, minLockedFraction = 0.8) {
  try {
    tokenAddress = ethers.getAddress(tokenAddress); // checksum

    return await withRpc(async (prov) => {
      // ====== Get Pair Address ======
      let pairAddress = cache.pairAddress.get(tokenAddress);
      if (!pairAddress) {
        const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
        pairAddress = await factory.getPair(tokenAddress, WBNB_ADDRESS);
        cache.pairAddress.set(tokenAddress, pairAddress);
      }

      if (!pairAddress || pairAddress === ethers.ZeroAddress)
        return { ok: false, status: "NO_LOCK", lockedPct: 0, maxLockDuration: 0 };

      // ====== Get Total Supply ======
      let totalSupply = cache.totalSupply.get(pairAddress);
      if (!totalSupply) {
        const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
        totalSupply = Number(ethers.formatUnits(await pair.totalSupply(), 18));
        cache.totalSupply.set(pairAddress, totalSupply);
      }

      if (totalSupply === 0)
        return { ok: false, status: "NO_LOCK", lockedPct: 0, maxLockDuration: 0 };

      // ====== Check Lockers ======
      let lockedAmount = 0;
      let maxLockDuration = 0;
      let hasLockerBalance = false;
      const now = Math.floor(Date.now() / 1000);

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

      for (const locker of LOCKERS) {
        try {
          const bal = Number(ethers.formatUnits(await pair.balanceOf(locker.address), 18));

          if (bal > 0) {
            lockedAmount += bal;
            hasLockerBalance = true;
          }

          if (locker.type === "time" && bal > 0) {
            const lockerContract = new ethers.Contract(locker.address, LOCK_ABI, prov);
            const unlock = await lockerContract.unlockTime();
            if (unlock > now) {
              maxLockDuration = Math.max(maxLockDuration, unlock - now);
            }
          }
        } catch {}
      }

      // ====== Apply Rules 1 → 4 ======
      const lockedPct = lockedAmount / totalSupply;

      let status = "NO_LOCK";
      let ok = false;

      // Rule 1 — no LP / drained
      if (totalSupply === 0 || lockedPct === 0) {
        status = "NO_LOCK";
      }
      // Rule 2 — LP in locker but no duration (PinkLock / fake lock)
      else if (hasLockerBalance && maxLockDuration === 0) {
        status = "FAKE_LOCK";
      }
      // Rule 3 — duration too short
      else if (lockedPct >= minLockedFraction && maxLockDuration < minLockSeconds) {
        status = "FAKE_LOCK";
      }
      // Rule 4 — legit lock
      else if (lockedPct >= minLockedFraction && maxLockDuration >= minLockSeconds) {
        status = "LOCKED";
        ok = true;
      }

      return { ok, status, lockedPct, maxLockDuration };
    });
  } catch (err) {
    console.error("LP verification failed:", err.message);
    return { ok: false, status: "NO_LOCK", lockedPct: 0, maxLockDuration: 0 };
  }
}