// file: lpVerifier.js
import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.BSC_RPC_1, process.env.BSC_RPC_2].filter(Boolean);
if (RPC_URLS.length < 1) throw new Error("At least 1 RPC required");

function norm(addr, label = "address") {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    throw new Error(`INVALID_${label.toUpperCase()}`);
  }
}

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

/* ================= CONSTANTS ================= */
const WBNB_ADDRESS = norm(process.env.WBNB_ADDRESS, "WBNB_ADDRESS");
const FACTORY_ADDRESS = norm(process.env.PANCAKE_FACTORY, "PANCAKE_FACTORY");

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();

// Keep lockers hardcoded for now because liquidityLock.js uses known ones too.
// If you later want dynamic lockers, pass them from liquidityLock and extend verifyLP signature.
const LOCKERS = [
  { name: "Unicrypt", address: norm("0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8", "UNICRYPT") },
  { name: "DxLocker", address: norm("0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21", "DXLOCKER") },
  { name: "PinkLock", address: norm("0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe", "PINKLOCK") },
  { name: "TeamFinance", address: norm("0xe2fe530c047f2d85298b07d9333c05737f1435fb", "TEAMFINANCE") }
];

const FACTORY_ABI = ["function getPair(address tokenA,address tokenB) view returns(address)"];
const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address owner) view returns(uint256)"
];

/* ================= MATH ================= */
function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function toBigIntSafe(x) {
  try {
    return BigInt(x);
  } catch {
    return 0n;
  }
}

function pctFraction(part, total) {
  if (total <= 0n) return 0;
  // return fraction 0..1 as Number
  // Note: converting to Number is safe here because it is a ratio, not a huge integer.
  return Number(part) / Number(total);
}

/* ================= CACHE ================= */
const cache = {
  pairAddress: new Map() // token -> pair
};

/* ================= CORE ================= */
/**
 * Compatibility contract with liquidityLock.js:
 * - lockedPct: fraction 0..1 (Number)
 * - burned: fraction 0..1 (Number)  <-- caller expects enhanced.burned >= minFrac
 * - maxLockDuration: always 0 (we removed duration)
 */
export async function verifyLP(tokenAddress, minLockSeconds = 0, minLockedFraction = 0.95) {
  // minLockSeconds kept only for signature compatibility
  void minLockSeconds;

  const token = norm(tokenAddress, "TOKEN");
  const minFrac = clamp01(minLockedFraction);

  try {
    return await withRpc(async (prov) => {
      // Pair
      let pairAddress = cache.pairAddress.get(token);
      if (!pairAddress) {
        const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
        const p = await factory.getPair(token, WBNB_ADDRESS);
        pairAddress = p ? p.toLowerCase() : ethers.ZeroAddress.toLowerCase();
        cache.pairAddress.set(token, pairAddress);
      }

      if (!pairAddress || pairAddress === ethers.ZeroAddress.toLowerCase()) {
        return {
          ok: false,
          status: "NO_LP",
          reason: "NO_PAIR",
          pairAddress: null,
          minFraction: minFrac,
          lockedPct: 0,
          burned: 0,
          maxLockDuration: 0,
          locked: "0",
          burnedRaw: "0",
          totalSupply: "0",
          lockerBreakdown: []
        };
      }

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

      // Total supply
      const ts = toBigIntSafe(await pair.totalSupply());
      if (ts === 0n) {
        return {
          ok: false,
          status: "TOTAL_SUPPLY_ZERO_UNSAFE",
          reason: "LP_TOTAL_SUPPLY_ZERO_UNSAFE",
          pairAddress,
          minFraction: minFrac,
          lockedPct: 0,
          burned: 0,
          maxLockDuration: 0,
          locked: "0",
          burnedRaw: "0",
          totalSupply: "0",
          lockerBreakdown: []
        };
      }

      // Burned LP (dead + zero)
      const [burnDead, burnZero] = await Promise.all([
        pair.balanceOf(DEAD_ADDRESS),
        pair.balanceOf(ZERO_ADDRESS)
      ]);

      const burnedRaw = toBigIntSafe(burnDead) + toBigIntSafe(burnZero);

      // Locked LP (known lockers)
      const lockerBalances = await Promise.all(
        LOCKERS.map(async (l) => {
          try {
            const bal = toBigIntSafe(await pair.balanceOf(l.address));
            return { name: l.name, address: l.address, balance: bal };
          } catch {
            return { name: l.name, address: l.address, balance: 0n };
          }
        })
      );

      const lockedRaw = lockerBalances.reduce((acc, x) => acc + x.balance, 0n);

      // Fractions (0..1)
      const burnedFrac = pctFraction(burnedRaw, ts);
      const lockedFrac = pctFraction(lockedRaw, ts);

      // Decide: burned OR locked is enough, no duration.
      const burnedOk = burnedFrac >= minFrac;
      const lockedOk = lockedFrac >= minFrac;

      let ok = false;
      let status = "UNSAFE";
      let reason = "LP_UNLOCKED_UNSAFE";

      if (burnedOk && !lockedOk) {
        ok = true;
        status = "BURNED";
        reason = "BURNED";
      } else if (!burnedOk && lockedOk) {
        ok = true;
        status = "LOCKED";
        reason = "LOCKED";
      } else if (burnedOk && lockedOk) {
        // This can happen. We do not require both, but if both are true it is still safe.
        ok = true;
        status = "BURNED_OR_LOCKED";
        reason = "BURNED_OR_LOCKED";
      }

      return {
        ok,
        status,
        reason,
        pairAddress,
        minFraction: minFrac,

        // fractions 0..1
        lockedPct: lockedFrac,
        burned: burnedFrac,

        // compatibility placeholder (removed duration logic)
        maxLockDuration: 0,

        // raw values for diagnostics
        totalSupply: ts.toString(),
        burnedRaw: burnedRaw.toString(),
        locked: lockedRaw.toString(),

        lockerBreakdown: lockerBalances
          .filter((x) => x.balance > 0n)
          .map((x) => ({
            name: x.name,
            address: x.address,
            balanceRaw: x.balance.toString()
          }))
      };
    });
  } catch (err) {
    return {
      ok: false,
      status: "ERROR",
      reason: "VERIFYLP_FAILED",
      pairAddress: null,
      minFraction: clamp01(minLockedFraction),
      lockedPct: 0,
      burned: 0,
      maxLockDuration: 0,
      locked: "0",
      burnedRaw: "0",
      totalSupply: "0",
      lockerBreakdown: [],
      error: err?.message || String(err)
    };
  }
}