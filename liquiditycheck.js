// file: liquidityLock.js
import { ethers } from "ethers";
import PQueue from "p-queue";
import { verifyLP } from "./lpVerifier.js"; // your validator

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_5, process.env.RPC_URL_6].filter(Boolean);
if (RPC_URLS.length < 2) throw new Error("At least 2 RPCs required");

const WBNB_ADDRESS = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FACTORY_ADDRESS = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";

const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address owner) view returns(uint256)"
];

const OFFICIAL_LOCKERS = [
  "0x5D47bAbAefbc3f2a1b20a36e7e6cB16e0eD7A6A8", // Unicrypt
  "0x9e7bD1A3aC2b1A7e94F5C927fBce6A0E631eEc21"  // DxLocker
];
const LOCK_ABI = ["function unlockTime() external view returns(uint256)"];

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });
let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

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

/* ================= LEGACY LOCK CHECK ================= */
async function checkLegacyLock(tokenAddress, lockerAddresses, minFraction = 0.8) {
  return withRpc(async (prov) => {
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ["function getPair(address,address) view returns(address)"],
      prov
    );
    const pairAddress = await factory.getPair(tokenAddress, WBNB_ADDRESS);
    if (!pairAddress || pairAddress === ethers.ZeroAddress)
      return { locked: false, lockedPct: 0 };

    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    const totalSupply = Number(ethers.formatUnits(await pair.totalSupply(), 18));
    if (!totalSupply) return { locked: false, lockedPct: 0 };

    let lockedAmount = 0;
    for (const addr of lockerAddresses) {
      lockedAmount += Number(ethers.formatUnits(await pair.balanceOf(addr), 18));
    }

    const lockedPct = lockedAmount / totalSupply;
    return { locked: lockedPct >= minFraction, lockedPct };
  });
}

/* ================= LOCK TIME ================= */
export async function lockTime(tokenAddress) {
  return withRpc(async (prov) => {
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ["function getPair(address,address) view returns(address)"],
      prov
    );
    const pairAddress = await factory.getPair(tokenAddress, WBNB_ADDRESS);
    if (!pairAddress || pairAddress === ethers.ZeroAddress) return null;

    for (const locker of OFFICIAL_LOCKERS) {
      try {
        const lockerContract = new ethers.Contract(locker, LOCK_ABI, prov);
        const unlock = await lockerContract.unlockTime();
        if (unlock && unlock > Math.floor(Date.now() / 1000)) {
          return unlock; // return the timestamp in seconds
        }
      } catch (err) {
        console.warn(`Cannot fetch unlockTime from locker ${locker}: ${err.message}`);
      }
    }

    return null; // no lock found
  });
}

/* ================= MAIN LIQUIDITY LOCK ================= */
export async function liquidityLock(tokenAddress, lockerAddresses = [], minFraction = 0.8) {
  return withRpc(async () => {
    const legacy = await checkLegacyLock(tokenAddress, lockerAddresses, minFraction);

    let enhanced = { locked: false, lockedPct: 0 };
    try {
      enhanced.locked = await verifyLP(tokenAddress, minFraction);
    } catch {
      enhanced.locked = false;
    }

    const finalLocked = legacy.locked || enhanced.locked;
    const lockedPct = Math.max(legacy.lockedPct, enhanced.lockedPct);

    const lpUnlockTime = await lockTime(tokenAddress);

    console.log(
      `Liquidity ${tokenAddress}: locked=${finalLocked}, lockedPct=${(lockedPct * 100).toFixed(2)}%, unlockTime=${lpUnlockTime}`
    );

    return { locked: finalLocked, lockedPct, unlockTime: lpUnlockTime };
  });
}

/* ================= SIMPLE TOTAL LIQUIDITY ================= */
export async function getTokenLiquidity(tokenAddress) {
  return withRpc(async (prov) => {
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ["function getPair(address,address) view returns(address)"],
      prov
    );
    const pairAddress = await factory.getPair(tokenAddress, WBNB_ADDRESS);
    if (!pairAddress || pairAddress === ethers.ZeroAddress) return 0;

    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    return Number(ethers.formatUnits(await pair.totalSupply(), 18));
  });
}