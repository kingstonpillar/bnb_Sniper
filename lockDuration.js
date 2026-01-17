// lockDuration.js
import "dotenv/config";
import { ethers } from "ethers";

/* ================= RPC ================= */
const RPC = process.env.BSC_RPC;
if (!RPC) throw new Error("BSC_RPC missing in .env");
const provider = new ethers.JsonRpcProvider(RPC);

function norm(a) {
  try {
    return ethers.getAddress(a);
  } catch {
    return null;
  }
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/* ================= LOCKERS ================= */
export const LOCKERS = [
  { name: "Unicrypt", address: norm("0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8") },
  { name: "DxLocker", address: norm("0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21") },
  { name: "PinkLock", address: norm("0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe") },
  { name: "TeamFinance", address: norm("0xe2fe530c047f2d85298b07d9333c05737f1435fb") }
].filter((x) => x.address);

/* ================= EVENT DECODERS =================
  NOTE:
  Lock ecosystems are messy across chains and versions.
  So we decode only if we can tie the lock to the LP address
  (pairAddress) AND read an unlock time field.

  You can extend these ABIs later per locker if needed.
*/

// Common-ish patterns:
const ABIS = {
  // Many lockers have some "LockCreated" or "Deposit" event.
  // We include a few candidates; if decoding fails, we ignore.
  genericCandidates: [
    // (token, owner, amount, lockDate, unlockDate)
    "event Deposit(address indexed token, address indexed owner, uint256 amount, uint256 lockDate, uint256 unlockDate)",
    // (token, amount, start, end)
    "event Locked(address indexed token, uint256 amount, uint256 start, uint256 end)",
    // (lpToken, owner, amount, unlockTime)
    "event LockCreated(address indexed token, address indexed owner, uint256 amount, uint256 unlockTime)",
    // Pinksale variants sometimes:
    "event LockAdded(uint256 indexed lockId, address indexed token, uint256 amount, uint256 unlockTime)"
  ]
};

const ifaces = ABIS.genericCandidates.map((s) => new ethers.Interface([s]));
const topics = ABIS.genericCandidates.map((s) => ethers.id(s.replace(/^event\s+/, "").trim()));

function extractUnlockFromParsed(parsed) {
  // Try common field names
  const args = parsed?.args;
  if (!args) return null;

  const candidates = [
    args.unlockDate,
    args.unlockTime,
    args.end,
    args.end_time,
    args.unlock_at
  ];

  for (const c of candidates) {
    if (c == null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // Fallback: last numeric arg often unlock
  for (let i = args.length - 1; i >= 0; i--) {
    const v = args[i];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractTokenFromParsed(parsed) {
  const args = parsed?.args;
  if (!args) return null;

  const candidates = [args.token, args.lpToken];
  for (const c of candidates) {
    if (typeof c === "string") return norm(c);
  }

  // Fallback: first address-like argument
  for (const v of args) {
    if (typeof v === "string" && v.startsWith("0x") && v.length === 42) {
      return norm(v);
    }
  }
  return null;
}

/* ================= MAIN ================= */
export async function lockDuration(pairAddress, { fromBlock = 0 } = {}) {
  const lp = norm(pairAddress);
  if (!lp) return { ok: false, reason: "INVALID_PAIR" };

  const now = nowSec();

  let best = {
    unlockTime: 0,
    locker: null,
    txHash: null,
    blockNumber: null
  };

  const matchedLockers = [];

  for (const locker of LOCKERS) {
    for (let ti = 0; ti < topics.length; ti++) {
      const topic0 = topics[ti];

      let logs = [];
      try {
        logs = await provider.getLogs({
          address: locker.address,
          fromBlock,
          toBlock: "latest",
          topics: [topic0]
        });
      } catch {
        continue;
      }

      for (const log of logs) {
        // Try decode with any interface
        let parsed = null;
        for (const iface of ifaces) {
          try {
            parsed = iface.parseLog({ topics: log.topics, data: log.data });
            break;
          } catch {
            // try next iface
          }
        }
        if (!parsed) continue;

        const tokenInEvent = extractTokenFromParsed(parsed);
        if (!tokenInEvent) continue;

        // Only accept locks explicitly referencing the LP token address
        if (tokenInEvent.toLowerCase() !== lp.toLowerCase()) continue;

        const unlock = extractUnlockFromParsed(parsed);
        if (!unlock || unlock <= now) continue;

        matchedLockers.push(locker.name);

        if (unlock > best.unlockTime) {
          best = {
            unlockTime: unlock,
            locker: locker.name,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber
          };
        }
      }
    }
  }

  if (!best.unlockTime) {
    return {
      ok: true,
      locked: false,
      lockDurationSeconds: 0,
      lockDurationDays: 0,
      unlockTime: 0,
      locker: null,
      lockersMatched: [],
      evidence: null
    };
  }

  const seconds = Math.max(0, best.unlockTime - now);
  const days = seconds / 86400;

  return {
    ok: true,
    locked: true,
    lockDurationSeconds: seconds,
    lockDurationDays: days,
    unlockTime: best.unlockTime,
    locker: best.locker,
    lockersMatched: uniq(matchedLockers),
    evidence: { txHash: best.txHash, blockNumber: best.blockNumber }
  };
}

/* ================= CONVENIENCE ================= */
export function isLockAtLeastDays(result, minDays = 90) {
  const d = Number(result?.lockDurationDays || 0);
  return Number.isFinite(d) && d >= minDays;
}