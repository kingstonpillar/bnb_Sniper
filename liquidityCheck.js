// file: liquidityLock.js
import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { verifyLP } from "./lpVerifier.js";
import { getGoPlusLockDuration } from "./goplusLockDuration.js";

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_5, process.env.RPC_URL_6].filter(Boolean);
if (RPC_URLS.length < 2) throw new Error("At least 2 RPCs required");

function norm(addr, label = "address") {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    throw new Error(`INVALID_${label.toUpperCase()}`);
  }
}

const WBNB_ADDRESS = norm(process.env.WBNB_ADDRESS, "WBNB_ADDRESS");
const FACTORY_ADDRESS = norm(process.env.PANCAKE_FACTORY, "PANCAKE_FACTORY");

// Burn sinks
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();

// Default known lockers (fallback only)
const DEFAULT_KNOWN_LOCKERS = [
  norm("0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8", "UNICRYPT_LOCKER"),
  norm("0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21", "DXLOCKER_LOCKER"),
  norm("0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe", "PINKLOCK"),
  norm("0xe2fe530c047f2d85298b07d9333c05737f1435fb", "TEAMFINANCE")
];

const FACTORY_ABI = ["function getPair(address tokenA,address tokenB) view returns(address)"];
const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address owner) view returns(uint256)"
];

/* ================= RPC ================= */
const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6,
  concurrency: 1,
  carryoverConcurrencyCount: true
});

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

/* ================= MATH HELPERS ================= */
function bps(part, total) {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total);
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/* ================= CORE RESOLUTION ================= */
async function getPairAddress(prov, tokenAddress) {
  const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
  const pair = await factory.getPair(tokenAddress, WBNB_ADDRESS);

  const p = norm(pair, "PAIR");
  if (p === ethers.ZeroAddress.toLowerCase()) return null;
  return p;
}

async function readLpTotals(prov, pairAddress) {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

  const [ts, burnDead, burnZero] = await Promise.all([
    pair.totalSupply(),
    pair.balanceOf(DEAD_ADDRESS),
    pair.balanceOf(ZERO_ADDRESS)
  ]);

  const totalSupply = BigInt(ts);
  const burned = BigInt(burnDead) + BigInt(burnZero);
  return { totalSupply, burned };
}

async function sumLockerBalances(prov, pairAddress, lockers) {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
  const bals = await Promise.all(
    lockers.map(async (a) => {
      try {
        return BigInt(await pair.balanceOf(a));
      } catch {
        return 0n;
      }
    })
  );
  return bals.reduce((acc, x) => acc + x, 0n);
}

/* ================= LEGACY SNAPSHOT ================= */
async function legacyLockSnapshot(prov, tokenAddress, knownLockers) {
  const pairAddress = await getPairAddress(prov, tokenAddress);
  if (!pairAddress) {
    return { ok: false, reason: "NO_PAIR", pairAddress: null, totalSupply: 0n, burned: 0n, locked: 0n };
  }

  const { totalSupply, burned } = await readLpTotals(prov, pairAddress);

  if (totalSupply === 0n) {
    return { ok: false, reason: "LP_TOTAL_SUPPLY_ZERO_UNSAFE", pairAddress, totalSupply, burned, locked: 0n };
  }

  const locked = await sumLockerBalances(prov, pairAddress, knownLockers);
  return { ok: true, reason: "OK", pairAddress, totalSupply, burned, locked };
}

/* ================= PUBLIC API ================= */
/**
 * Safe if:
 * - burnedPct >= minFraction OR lockedPct >= minFraction
 *
 * Extra rule:
 * - If final "reason" resolves to LOCKED, require GoPlus maxLockDuration >= minLockSeconds
 * - No duration gate for BURNED
 *
 * Changes you requested:
 * - Use "knownLockers" terminology (not OFFICIAL_LOCKERS)
 * - Await GoPlus duration properly, and pass knownLockers into getGoPlusLockDuration()
 */
export async function liquidityLock(
  tokenAddress,
  knownLockers = DEFAULT_KNOWN_LOCKERS,
  minFraction = 0.95,
  minLockSeconds = 90 * 24 * 60 * 60
) {
  const token = norm(tokenAddress, "TOKEN");

  const lockersArr = Array.isArray(knownLockers) ? knownLockers : [];
  const lockers = lockersArr.map((a) => norm(a, "KNOWN_LOCKER"));

  const minFrac = clamp01(minFraction);

  // If token normalization fails, return a valid object (do not throw)
  if (!token) {
    return {
      ok: false,
      pass: false,
      token: null,
      pairAddress: null,
      locked: false,
      reason: "TOKEN_INVALID",
      lockedPct: 0,
      burnedPct: 0,
      totalSupply: "0",
      burned: "0",
      lockedAmount: "0",
      durationGate: {
        enabled: false,
        ok: false,
        hasDuration: false,
        matchedKnownLocker: false,
        matchedLockers: [],
        maxLockDuration: 0,
        minLockSeconds
      },
      finalOk: false
    };
  }

  return withRpc(async (prov) => {
    const legacy = await legacyLockSnapshot(prov, token, lockers);

    // legacy snapshot failed (pair missing, supply unreadable, etc.)
    if (!legacy || legacy.ok !== true) {
      const pairAddress = legacy?.pairAddress || null;
      const totalSupply = legacy?.totalSupply ? String(legacy.totalSupply) : "0";

      return {
        ok: true,
        pass: false,
        finalOk: false,

        token,
        pairAddress,

        locked: false,
        reason: legacy?.reason || "LEGACY_SNAPSHOT_FAILED",

        lockedPct: 0,
        burnedPct: 0,

        totalSupply,
        burned: "0",
        lockedAmount: "0",

        durationGate: {
          enabled: false,
          ok: true,
          hasDuration: false,
          matchedKnownLocker: false,
          matchedLockers: [],
          maxLockDuration: 0,
          minLockSeconds
        }
      };
    }

    const burnedPct = bps(legacy.burned, legacy.totalSupply) / 10000;
    const lockedPct = bps(legacy.locked, legacy.totalSupply) / 10000;

    const legacyBurnSafe = burnedPct >= minFrac;
    const legacyLockerSafe = lockedPct >= minFrac;

    // Secondary confirmation (verifyLP)
    let enhanced = {
      ok: false,
      lockedPct: 0,
      burned: 0,
      status: "UNSAFE",
      reason: "VERIFYLP_FAILED"
    };

    try {
      const r = await verifyLP(token, 0, minFrac);
      if (r && typeof r === "object") {
        enhanced = {
          ok: Boolean(r.ok),
          lockedPct: Number(r.lockedPct || 0),
          burned: Number(r.burned || 0),
          status: String(r.status || (r.ok ? "SAFE" : "UNSAFE")),
          reason: String(r.reason || (r.ok ? "LOCKED" : "UNSAFE"))
        };
      }
    } catch {
      // keep default enhanced
    }

    // Burn OR Lock is enough
    const lockedByBurn = legacyBurnSafe || (Number.isFinite(enhanced.burned) && enhanced.burned >= minFrac);
    const lockedByLocker = legacyLockerSafe || enhanced.ok;

    const finalLocked = lockedByBurn || lockedByLocker;

    const finalLockedPct = Math.max(lockedPct, enhanced.lockedPct || 0);
    const finalBurnedPct = Math.max(burnedPct, enhanced.burned || 0);

    let reason = "LP_UNLOCKED_UNSAFE";
    if (finalLocked) {
      if (lockedByBurn && !lockedByLocker) reason = "BURNED";
      else if (!lockedByBurn && lockedByLocker) reason = "LOCKED";
      else reason = "BURNED_OR_LOCKED";
    }

    // GoPlus duration gate only when the lock came from lockers (not burns)
    let duration = {
      ok: false,
      hasDuration: false,
      maxLockDuration: 0,
      matchedKnownLocker: false,
      matchedLockers: []
    };

    if (reason === "LOCKED") {
      try {
        duration = await getGoPlusLockDuration({
          chainId: 56,
          tokenOrLp: legacy.pairAddress, // LP pair address
          knownLockers: lockers
        });
      } catch {
        duration = {
          ok: false,
          hasDuration: false,
          maxLockDuration: 0,
          matchedKnownLocker: false,
          matchedLockers: []
        };
      }
    }

    const durationOk =
      reason !== "LOCKED" ||
      (
        duration.ok === true &&
        duration.hasDuration === true &&
        Number(duration.maxLockDuration || 0) >= minLockSeconds &&
        Boolean(duration.matchedKnownLocker)
      );

    const finalOk = Boolean(finalLocked && durationOk);

    return {
      ok: true,

      // This is what your buyCaller should check
      pass: finalOk,
      finalOk,

      token,
      pairAddress: legacy.pairAddress,

      locked: Boolean(finalLocked),
      reason,

      lockedPct: Number.isFinite(finalLockedPct) ? finalLockedPct : 0,
      burnedPct: Number.isFinite(finalBurnedPct) ? finalBurnedPct : 0,

      totalSupply: legacy.totalSupply.toString(),
      burned: legacy.burned.toString(),
      lockedAmount: legacy.locked.toString(),

      durationGate: {
        enabled: reason === "LOCKED",
        ok: Boolean(durationOk),
        hasDuration: Boolean(duration.hasDuration),
        matchedKnownLocker: Boolean(duration.matchedKnownLocker),
        matchedLockers: Array.isArray(duration.matchedLockers) ? duration.matchedLockers : [],
        maxLockDuration: Number(duration.maxLockDuration || 0),
        minLockSeconds
      }
    };
  });
}

/* ================= SIMPLE TOTAL LIQUIDITY (LP TOTAL SUPPLY) =================
 * What it does (precisely):
 * - Finds the Pancake pair for (token, WBNB) via the Factory
 * - If no pair exists, returns 0
 * - If pair exists, reads pair.totalSupply() and returns it as a Number (18 decimals)
 *
 * Important: This is NOT “liquidity in BNB” or “TVL”.
 * - totalSupply() here is the total amount of LP tokens minted for that pair.
 * - LP totalSupply increases when liquidity is added and decreases when liquidity is removed.
 * - It is useful for detecting LP mint/burn events and relative LP supply changes over time.
 *
 * Limitations:
 * - LP tokens are 18 decimals on Pancake pairs, but relying on 18 is an assumption.
 * - Returning a JS Number can lose precision for very large LP supplies.
 * - It does not account for LP tokens locked/burned; it only returns total minted LP.
 */
export async function getTokenLiquidity(tokenAddressRaw) {
  // Normalize/checksum early, fail closed
  let tokenAddress;
  try {
    tokenAddress = ethers.getAddress(tokenAddressRaw);
  } catch {
    return 0;
  }

  return withRpc(async (prov) => {
    // 1) Resolve pair
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ["function getPair(address,address) view returns(address)"],
      prov
    );

    const pairAddressRaw = await factory.getPair(tokenAddress, WBNB_ADDRESS);
    if (!pairAddressRaw || pairAddressRaw === ethers.ZeroAddress) return 0;

    let pairAddress;
    try {
      pairAddress = ethers.getAddress(pairAddressRaw);
    } catch {
      return 0;
    }

    // 2) Read LP totalSupply
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

    let totalSupplyRaw;
    try {
      totalSupplyRaw = await pair.totalSupply();
    } catch {
      return 0;
    }

    // Pancake LP is 18 decimals; if you want to be strict, you can fetch decimals() too.
    const totalSupply = Number(ethers.formatUnits(totalSupplyRaw, 18));
    return Number.isFinite(totalSupply) && totalSupply >= 0 ? totalSupply : 0;
  }).catch(() => 0);
}