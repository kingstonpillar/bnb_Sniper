// file: liquidityLock.js
import dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import PQueue from "p-queue";
import { verifyLP } from "./lpVerifier.js"; // enhanced validator

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_5, process.env.RPC_URL_6].filter(Boolean);
if (RPC_URLS.length < 2) throw new Error("At least 2 RPCs required");

const WBNB_ADDRESS = process.env.WBNB_ADDRESS.toLowerCase();
const FACTORY_ADDRESS = process.env.PANCAKE_FACTORY.toLowerCase();
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address owner) view returns(uint256)"
];

const OFFICIAL_LOCKERS = [
  ethers.getAddress("0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8"), // Unicrypt
  ethers.getAddress("0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21")  // DxLocker
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
      return { locked: false, lockedPct: 0, burned: 0 };

    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    const totalSupply = Number(ethers.formatUnits(await pair.totalSupply(), 18));
    if (!totalSupply) return { locked: false, lockedPct: 0, burned: 0 };

    // Burned LP
    const burned = Number(ethers.formatUnits(await pair.balanceOf(DEAD_ADDRESS), 18));

    let lockedAmount = 0;
    for (const addr of lockerAddresses) {
      lockedAmount += Number(ethers.formatUnits(await pair.balanceOf(addr), 18));
    }

    const lockedPct = lockedAmount / totalSupply;
    return { locked: lockedPct >= minFraction, lockedPct, burned };
  });
}

/* ================= MAIN LIQUIDITY LOCK ================= */
export async function liquidityLock(tokenAddress, lockerAddresses = OFFICIAL_LOCKERS, minFraction = 0.7, minLockSeconds = 90*24*60*60) {
  return withRpc(async () => {
    // Legacy check
    const legacy = await checkLegacyLock(tokenAddress, lockerAddresses, minFraction);

    // Enhanced LP check (lockers with duration + burned LP)
    let enhanced = { ok: false, lockedPct: 0, maxLockDuration: 0, burned: 0, status: "UNSAFE" };
    try {
      enhanced = await verifyLP(tokenAddress, minLockSeconds, minFraction);
    } catch {}

    // Decide final safe status: either burned LP or locked LP is enough
    const finalLocked = legacy.burned > 0 || enhanced.ok;
    const lockedPct = Math.max(legacy.lockedPct, enhanced.lockedPct);
    const burned = Math.max(legacy.burned, enhanced.burned);
    const maxLockDuration = enhanced.maxLockDuration;

    // Determine reason/status
    let reason = "UNSAFE";
    if (burned > 0) reason = "BURNED";
    if (enhanced.ok) reason = "LOCKED";

    console.log(
      `Liquidity ${tokenAddress}: locked=${finalLocked}, lockedPct=${(lockedPct*100).toFixed(2)}%, burned=${burned}, maxLockDuration=${(maxLockDuration/86400).toFixed(1)} days, status=${reason}`
    );

    return { locked: finalLocked, lockedPct, burned, maxLockDuration, reason };
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