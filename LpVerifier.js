// file: lpVerifier.js
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= CONFIG ================= */
const RPC_URLS = [
  process.env.BSC_RPC_1,
  process.env.BSC_RPC_2
].filter(Boolean);

if (RPC_URLS.length < 1) throw new Error("At least 1 RPC required");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

// PQueue rate limiter for RPC calls
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

// WBNB address for pair calculation
const WBNB_ADDRESS = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

// PancakeSwap Factory
const FACTORY_ADDRESS = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

// Pair ABI
const PAIR_ABI = [
  "function totalSupply() external view returns(uint256)",
  "function balanceOf(address owner) external view returns(uint256)"
];

// Known official LP lockers
const OFFICIAL_LOCKERS = [
  "0x5D47bAbAefbc3f2a1b20a36e7e6cB16e0eD7A6A8", // Unicrypt
  "0x9e7bD1A3aC2b1A7e94F5C927fBce6A0E631eEc21"  // DxLocker
];

// Known dynamic top LP lockers
const KNOWN_LOCKERS = [
  "0xC765bddB93b0d1c1A88282BA0fa6B2d00E3e0c83",
  "0xfe88DAB083964C56429baa01F37eC2265AbF1557",
  "0x7f5EF2cE9150ffE2796F62F1177fc6F22a527E5",
  "0xe0c3ab2c69d8b43d8B0d922aFa224A0AB6780dE1"
];

/**
 * Get top N LP holders for a pair
 */
async function getTopHolders(pairAddress, topN = 10) {
  return await withRpc(async (prov) => {
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    // Placeholder: on-chain top holder enumeration is complex
    return [];
  });
}

/**
 * Verify LP tokens are locked
 */
export async function verifyLP(tokenAddress, minLockedFraction = 0.8, minLockSeconds = 30*24*60*60) {
  try {
    return await withRpc(async (prov) => {
      const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
      const pairAddress = await factory.getPair(tokenAddress, WBNB_ADDRESS);
      if (pairAddress === ethers.constants.AddressZero) return false;

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
      const totalSupply = Number(ethers.formatUnits(await pair.totalSupply(), 18));
      if (totalSupply === 0) return false;

      let lockedAmount = 0;
      const now = Math.floor(Date.now() / 1000);

      // Official lockers check
      for (const locker of OFFICIAL_LOCKERS) {
        try {
          const bal = Number(ethers.formatUnits(await pair.balanceOf(locker), 18));
          lockedAmount += bal;

          const LOCK_ABI = ["function unlockTime() external view returns(uint256)"];
          const lockerContract = new ethers.Contract(locker, LOCK_ABI, prov);
          const unlock = await lockerContract.unlockTime();
          if ((unlock - now) < minLockSeconds) return false;
        } catch (err) {
          console.warn(`Cannot verify locker ${locker}: ${err.message}`);
        }
      }

      // Known dynamic lockers check
      const topHolders = await getTopHolders(pairAddress);
      const hasKnownLocker = topHolders.some(h => KNOWN_LOCKERS.includes(h.address));
      if (hasKnownLocker) return true;

      const lockedFraction = lockedAmount / totalSupply;
      return lockedFraction >= minLockedFraction;
    });
  } catch (err) {
    console.error("LP verification failed:", err.message);
    return false;
  }
}