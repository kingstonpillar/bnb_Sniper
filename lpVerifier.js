// file: lpVerifier.js
import dotenv from "dotenv";
dotenv.config();  // <-- load .env
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
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS.toLowerCase();
const OFFICIAL_LOCKERS = [
  "0x5D47bAbAefbc3f2a1b20a36e7e6cB16e0eD7A6A8", // Unicrypt
  "0x9e7bD1A3aC2b1A7e94F5C927fBce6A0E631eEc21"  // DxLocker
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
export async function verifyLP(tokenAddress, minLockSeconds = 90*24*60*60, minLockedFraction = 0.8) {
  try {
    return await withRpc(async (prov) => {
      // Cache pair address
      let pairAddress = cache.pairAddress.get(tokenAddress);
      if (!pairAddress) {
        const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
        pairAddress = await factory.getPair(tokenAddress, WBNB_ADDRESS);
        cache.pairAddress.set(tokenAddress, pairAddress);
      }
      if (!pairAddress || pairAddress === ethers.constants.AddressZero)
        return { ok: false, lockedPct: 0, maxLockDuration: 0 };

      // Cache total supply
      let totalSupply = cache.totalSupply.get(pairAddress);
      if (!totalSupply) {
        const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
        totalSupply = Number(ethers.formatUnits(await pair.totalSupply(), 18));
        cache.totalSupply.set(pairAddress, totalSupply);
      }
      if (totalSupply === 0)
        return { ok: false, lockedPct: 0, maxLockDuration: 0 };

      let lockedAmount = 0;
      let maxLockDuration = 0;
      const now = Math.floor(Date.now() / 1000);

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

      // Check official lockers
      for (const locker of OFFICIAL_LOCKERS) {
        try {
          const bal = Number(ethers.formatUnits(await pair.balanceOf(locker), 18));
          lockedAmount += bal;

          const lockerContract = new ethers.Contract(locker, LOCK_ABI, prov);
          const unlock = await lockerContract.unlockTime();

          if (unlock && unlock > now) {
            const duration = unlock - now;
            if (duration > maxLockDuration) maxLockDuration = duration;
          }
        } catch (err) {
          console.warn(`Cannot fetch unlockTime for locker ${locker}: ${err.message}`);
        }
      }

      const lockedFraction = lockedAmount / totalSupply;
      const ok = lockedFraction >= minLockedFraction && maxLockDuration >= minLockSeconds;

      return { ok, lockedPct: lockedFraction, maxLockDuration };
    });
  } catch (err) {
    console.error("LP verification failed:", err.message);
    return { ok: false, lockedPct: 0, maxLockDuration: 0 };
  }
}