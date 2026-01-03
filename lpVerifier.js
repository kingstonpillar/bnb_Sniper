// file: lpVerifier.js
import dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.BSC_RPC_1, process.env.BSC_RPC_2].filter(Boolean);
if (RPC_URLS.length < 1) throw new Error("At least 1 RPC required");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
}

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
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

const LOCKERS = [
  {
    name: "Unicrypt",
    address: ethers.getAddress("0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8"),
    type: "time"
  },
  {
    name: "DxLocker",
    address: ethers.getAddress("0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21"),
    type: "time"
  },
  {
    name: "PinkLock",
    address: ethers.getAddress("0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE"),
    type: "time"
  },
  {
    name: "Team Finance LP Locker",
    address: ethers.getAddress("0xe2fe530c047f2d85298b07d9333c05737f1435fb"),
    type: "time"
  }
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

      if (!pairAddress || pairAddress === ethers.ZeroAddress) {
        return { ok: false, status: "NO_LP", lockedPct: 0, maxLockDuration: 0, burned: 0 };
      }

      // ====== Get Total Supply ======
      let totalSupply = cache.totalSupply.get(pairAddress);
      if (!totalSupply) {
        const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
        totalSupply = Number(ethers.formatUnits(await pair.totalSupply(), 18));
        cache.totalSupply.set(pairAddress, totalSupply);
      }

      if (totalSupply === 0) {
        return { ok: false, status: "NO_LP", lockedPct: 0, maxLockDuration: 0, burned: 0 };
      }

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

      // ====== Check Burned LP ======
      const burnedLP = Number(ethers.formatUnits(await pair.balanceOf(DEAD_ADDRESS), 18));
      const burnedPct = burnedLP / totalSupply;

      // ====== Check Official Lockers ======
      let lockedAmount = 0;
      let maxLockDuration = 0;
      const now = Math.floor(Date.now() / 1000);

      for (const locker of LOCKERS) {
        try {
          const bal = Number(ethers.formatUnits(await pair.balanceOf(locker.address), 18));
          if (bal > 0) {
            lockedAmount += bal;
            if (locker.type === "time") {
              const lockerContract = new ethers.Contract(locker.address, LOCK_ABI, prov);
              const unlock = await lockerContract.unlockTime();
              if (unlock > now) {
                maxLockDuration = Math.max(maxLockDuration, unlock - now);
              }
            }
          }
        } catch {}
      }

      const lockedPct = lockedAmount / totalSupply;

      // ====== Determine if safe ======
      let ok = false;
      let status = "UNSAFE";

      if (burnedLP > 0) {
        ok = true;
        status = "BURNED";
      }
      if (lockedPct >= minLockedFraction && maxLockDuration >= minLockSeconds) {
        ok = true;
        status = "LOCKED";
      }

      return { ok, status, lockedPct, maxLockDuration, burned: burnedLP };
    });
  } catch (err) {
    console.error("LP verification failed:", err.message);
    return { ok: false, status: "ERROR", lockedPct: 0, maxLockDuration: 0, burned: 0 };
  }
}