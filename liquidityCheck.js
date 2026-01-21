// file: liquidityLock.js
import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { verifyLP } from "./lpVerifier.js";
import { getGoPlusLiquidityLock } from "./goplusLiquidityLock.js";

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_5, process.env.RPC_URL_6].filter(Boolean);
if (RPC_URLS.length < 2) throw new Error("At least 2 RPCs required");

const WBNB_ADDRESS = ethers.getAddress(process.env.WBNB_ADDRESS).toLowerCase();
const FACTORY_ADDRESS = ethers.getAddress(process.env.PANCAKE_FACTORY).toLowerCase();

const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = ethers.ZeroAddress.toLowerCase();

/* ================= ABIS ================= */
const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)"
];

/* ================= RPC ================= */
const queue = new PQueue({ interval: 1000, intervalCap: 6, concurrency: 1 });
let idx = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[idx]);

function rotateRpc() {
  idx = (idx + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[idx]);
}

async function withRpc(fn) {
  let last;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await queue.add(() => fn(provider));
    } catch (e) {
      last = e;
      rotateRpc();
    }
  }
  throw last;
}

/* ================= HELPERS ================= */
function bps(part, total) {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total);
}

/* ================= CORE ================= */
async function getPairAddress(prov, token) {
  const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
  const pair = await factory.getPair(token, WBNB_ADDRESS);
  if (!pair || pair === ethers.ZeroAddress) return null;
  return ethers.getAddress(pair).toLowerCase();
}

async function readLpSnapshot(prov, pair) {
  const c = new ethers.Contract(pair, PAIR_ABI, prov);
  const [ts, d, z] = await Promise.all([
    c.totalSupply(),
    c.balanceOf(DEAD),
    c.balanceOf(ZERO)
  ]);

  return {
    totalSupply: BigInt(ts),
    burned: BigInt(d) + BigInt(z)
  };
}

/* ================= PUBLIC API ================= */
export async function liquidityLock(
  tokenAddress,
  minFraction = 0.95
) {
  let token;
  try {
    token = ethers.getAddress(tokenAddress).toLowerCase();
  } catch {
    return { ok: false, pass: false, reason: "INVALID_TOKEN" };
  }

  return withRpc(async (prov) => {
    const pair = await getPairAddress(prov, token);
    if (!pair) {
      return {
        ok: true,
        pass: false,
        locked: false,
        reason: "NO_PAIR",
        pairAddress: null
      };
    }

    const snap = await readLpSnapshot(prov, pair);
    if (snap.totalSupply === 0n) {
      return {
        ok: true,
        pass: false,
        locked: false,
        reason: "LP_SUPPLY_ZERO",
        pairAddress: pair
      };
    }

    const burnedPct = bps(snap.burned, snap.totalSupply) / 10000;
    const burnedSafe = burnedPct >= minFraction;

    // External verification (non-blocking)
    let verifySafe = false;
    try {
      const v = await verifyLP(token, 0, minFraction);
      verifySafe = Boolean(v?.ok);
    } catch {}

    // GoPlus binary lock signal (PAIR based)
    let goplusLocked = false;
    try {
      const r = await getGoPlusLiquidityLock({ pairAddress: pair });
      goplusLocked = Boolean(r?.ok && r?.locked);
    } catch {}

    // Final decision: burn OR verifyLP OR GoPlus
    const locked = burnedSafe || verifySafe || goplusLocked;

    return {
      ok: true,
      pass: locked,
      locked,
      reason: locked
        ? burnedSafe
          ? "BURNED"
          : goplusLocked
          ? "LOCK_SIGNAL"
          : "VERIFIED"
        : "UNLOCKED",
      token,
      pairAddress: pair,
      burnedPct,
      signals: {
        burned: burnedSafe,
        verifyLP: verifySafe,
        goplus: goplusLocked
      }
    };
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