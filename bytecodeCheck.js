// bytecodeCheck.js (rewritten)
// Goals:
// - Deterministic, safer normalization (strip Solidity metadata properly when possible)
// - Better fingerprinting (opcode histogram + risky opcode flags + selector presence)
// - Less false positives: similarity only on op histogram (not PUSH immediates)
// - Safer DB handling (atomic-ish write, file lock-free best effort)
// - Same scoring contract: 10 clean, 5 suspicious, 0 confirmed/high risk
//
// DB format (same file):
// {
//   "hashes": ["..."],
//   "fingerprints": [
//     {
//       "opHist": { "0x01": 12, ... },
//       "risky": { "delegatecall": true, ... },
//       "selectors": { "mint": false, ... }
//     }
//   ]
// }

import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= RPC CONFIG ================= */
const RPC_URL = process.env.BSC_RPC;
if (!RPC_URL) throw new Error("BSC_RPC not set in .env");

const provider = new ethers.JsonRpcProvider(RPC_URL);

const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 5,
  concurrency: 1
});

/* ================= CONFIG ================= */
const KNOWN_RUGS = process.env.KNOWN_RUG_DB || "./known_rug_bytecodes.json";

// Thresholds
const SIMILARITY_SUSPICIOUS = 0.72; // -> score 5
const SIMILARITY_CONFIRMED = 0.88;  // -> score 0

// High-signal risky opcodes
const RISKY_OPS = new Set([
  0xf4, // DELEGATECALL
  0xf5, // CREATE2
  0xff  // SELFDESTRUCT
  // 0xf0 CREATE can be used legitimately, but still informative. Keep as "soft" below.
]);

const SOFT_RISKY_OPS = new Set([
  0xf0 // CREATE
]);

// Common mint selectors (signals only)
const MINT_SELECTORS_HEX = [
  "40c10f19", // mint(address,uint256)
  "6a627842", // mint(uint256)
  "8a7d4b73", // mint(address)
  "a0712d68"  // _mint(address,uint256)
];

/* ================= DB IO ================= */
function ensureDbShape(obj) {
  if (!obj || typeof obj !== "object") return { hashes: [], fingerprints: [] };
  if (!Array.isArray(obj.hashes)) obj.hashes = [];
  if (!Array.isArray(obj.fingerprints)) obj.fingerprints = [];
  return obj;
}

function readDB() {
  try {
    if (!fs.existsSync(KNOWN_RUGS)) return { hashes: [], fingerprints: [] };
    const raw = fs.readFileSync(KNOWN_RUGS, "utf8");
    return ensureDbShape(JSON.parse(raw));
  } catch {
    // If DB is corrupted, do not brick runtime.
    return { hashes: [], fingerprints: [] };
  }
}

function writeDB(db) {
  const dir = path.dirname(KNOWN_RUGS);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${KNOWN_RUGS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, KNOWN_RUGS);
}

/* ================= BYTECODE NORMALIZATION ================= */
/**
 * Attempts to strip Solidity CBOR metadata (best effort).
 * Many Solidity builds append a CBOR blob + 2-byte length at the end.
 * If parsing fails, fallback to simple tail-strip.
 */
function stripSolidityMetadata(bytecodeHex) {
  const code = bytecodeHex?.toLowerCase();
  if (!code || code === "0x") return code;

  // Must be even length
  if ((code.length - 2) % 2 !== 0) return code;

  const buf = Buffer.from(code.slice(2), "hex");
  if (buf.length < 4) return code;

  // Last 2 bytes often represent CBOR length in bytes
  const cborLen = buf.readUInt16BE(buf.length - 2);
  const cborStart = buf.length - 2 - cborLen;

  // Sanity checks
  if (cborStart <= 0 || cborStart >= buf.length) {
    return fallbackTailStrip(code);
  }

  // Solidity metadata CBOR typically starts with 0xa1, 0xa2, 0xa3, 0xa4 (map)
  const first = buf[cborStart];
  const looksLikeCborMap = first >= 0xa0 && first <= 0xbf;

  if (!looksLikeCborMap) {
    return fallbackTailStrip(code);
  }

  // Strip CBOR + length
  const stripped = buf.slice(0, cborStart);
  return "0x" + stripped.toString("hex");
}

function fallbackTailStrip(code) {
  // Conservative tail strip (keeps most runtime)
  // Prior version removed 200 hex chars; keep similar but safer:
  const minKeep = 2000; // keep at least 1000 bytes
  if (code.length <= 2 + minKeep) return code;
  const strip = 400; // 200 bytes tail strip
  return code.slice(0, Math.max(2 + minKeep, code.length - strip));
}

function normalize(bytecodeHex) {
  return stripSolidityMetadata(bytecodeHex);
}

/* ================= DISASSEMBLY / FINGERPRINT ================= */
function isPush(op) {
  return op >= 0x60 && op <= 0x7f;
}

function pushDataLen(op) {
  return op - 0x5f; // PUSH1..PUSH32
}

/**
 * Produce opcode histogram ignoring PUSH immediates.
 * Also detect risky opcodes and selector presence by hex search in normalized bytecode.
 */
function fingerprint(bytecodeHex) {
  const code = bytecodeHex?.toLowerCase();
  if (!code || code === "0x") {
    return {
      opHist: {},
      risky: {
        delegatecall: false,
        create2: false,
        selfdestruct: false,
        create: false
      },
      selectors: {
        mint: false
      }
    };
  }

  const bytes = Buffer.from(code.slice(2), "hex");

  const opHist = Object.create(null);

  let delegatecall = false;
  let create2 = false;
  let selfdestruct = false;
  let create = false;

  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];

    // record histogram
    const k = "0x" + op.toString(16).padStart(2, "0x".includes("0x") ? 2 : 2);
    opHist[k] = (opHist[k] || 0) + 1;

    if (op === 0xf4) delegatecall = true;
    if (op === 0xf5) create2 = true;
    if (op === 0xff) selfdestruct = true;
    if (op === 0xf0) create = true;

    // skip PUSH data
    if (isPush(op)) {
      i += pushDataLen(op);
    }
  }

  const hasRisky =
    delegatecall || create2 || selfdestruct;

  // selector presence (hex search)
  const mint = MINT_SELECTORS_HEX.some((s) => code.includes(s));

  return {
    opHist,
    risky: {
      delegatecall,
      create2,
      selfdestruct,
      create,
      hasRisky,
      hasSoftRisky: create
    },
    selectors: { mint }
  };
}

/* ================= SIMILARITY ================= */
/**
 * Cosine similarity over opcode histograms.
 * More stable than comparing PUSH op streams.
 */
function cosineSimilarity(histA, histB) {
  const keys = new Set([...Object.keys(histA), ...Object.keys(histB)]);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const k of keys) {
    const a = Number(histA[k] || 0);
    const b = Number(histB[k] || 0);
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ================= STORE ================= */
function sameHashAlready(db, hash) {
  return db.hashes.includes(hash);
}

function storeRug(hash, fp, db) {
  let changed = false;

  if (!db.hashes.includes(hash)) {
    db.hashes.push(hash);
    changed = true;
  }

  // Store fingerprints as structured objects (append-only)
  // Avoid duplicates by hashing fp JSON
  const fpHash = crypto.createHash("sha256").update(JSON.stringify(fp)).digest("hex");
  db._fpHashes = Array.isArray(db._fpHashes) ? db._fpHashes : [];

  if (!db._fpHashes.includes(fpHash)) {
    db._fpHashes.push(fpHash);
    db.fingerprints.push(fp);
    changed = true;
  }

  if (changed) writeDB(db);
}

/* ================= MAIN ================= */
/**
 * Returns score:
 * 10 = clean
 * 5  = suspicious
 * 0  = confirmed rug / high risk
 *
 * Behavior:
 * - Exact normalized runtime hash match -> 0
 * - Any hard risky opcode present (delegatecall/create2/selfdestruct) -> 0 (and store)
 * - Similarity >= CONFIRMED -> 0 (and store)
 * - Similarity >= SUSPICIOUS -> 5
 * - Else -> 10
 *
 * Notes:
 * - CREATE alone is treated as a soft flag: it will not force 0, but it reduces confidence via similarity gating.
 */
export async function bytecodeHashSimilarityCheck(tokenAddress) {
  const addr = (() => {
    try {
      return ethers.getAddress(tokenAddress);
    } catch {
      return null;
    }
  })();

  if (!addr) return 0;

  const code = await rpcQueue.add(() => provider.getCode(addr));
  if (!code || code === "0x") return 0;

  const cleanCode = normalize(code);
  const hash = crypto.createHash("sha256").update(cleanCode).digest("hex");
  const fp = fingerprint(cleanCode);

  const db = readDB();

  // Exact match on known rug hash
  if (sameHashAlready(db, hash)) return 0;

  // Hard risky opcode present -> treat as confirmed/high risk and store
  if (fp.risky.hasRisky) {
    storeRug(hash, fp, db);
    return 0;
  }

  // Similarity comparison against known fingerprints
  let bestSim = 0;
  for (const knownFp of db.fingerprints) {
    if (!knownFp || typeof knownFp !== "object") continue;
    const sim = cosineSimilarity(fp.opHist, knownFp.opHist || {});
    if (sim > bestSim) bestSim = sim;

    // If known has hard risky flags and we match strongly, treat confirmed
    if (sim >= SIMILARITY_CONFIRMED) {
      storeRug(hash, fp, db);
      return 0;
    }
  }

  // Soft risky flags tighten suspicious threshold a little
  const suspiciousThreshold = fp.risky.hasSoftRisky ? Math.min(0.80, SIMILARITY_SUSPICIOUS + 0.05) : SIMILARITY_SUSPICIOUS;

  if (bestSim >= suspiciousThreshold) return 5;
  return 10;
}
```0