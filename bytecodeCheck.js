// bytecodeCheck.js
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

const SIMILARITY_SUSPICIOUS = 0.72; // -> score 5
const SIMILARITY_CONFIRMED = 0.88;  // -> score 0

const MINT_SELECTORS_HEX = ["40c10f19", "6a627842", "8a7d4b73", "a0712d68"];

/* ================= DB IO ================= */
function ensureDbShape(obj) {
  if (!obj || typeof obj !== "object") return { hashes: [], fingerprints: [], _fpHashes: [] };
  if (!Array.isArray(obj.hashes)) obj.hashes = [];
  if (!Array.isArray(obj.fingerprints)) obj.fingerprints = [];
  if (!Array.isArray(obj._fpHashes)) obj._fpHashes = [];
  return obj;
}

function writeDB(db) {
  const dir = path.dirname(KNOWN_RUGS);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${KNOWN_RUGS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, KNOWN_RUGS);
}

function readDB() {
  try {
    if (!fs.existsSync(KNOWN_RUGS)) {
      const fresh = { hashes: [], fingerprints: [], _fpHashes: [] };
      writeDB(fresh);
      return fresh;
    }
    const raw = fs.readFileSync(KNOWN_RUGS, "utf8");
    if (!raw || !raw.trim()) {
      const fresh = { hashes: [], fingerprints: [], _fpHashes: [] };
      writeDB(fresh);
      return fresh;
    }
    return ensureDbShape(JSON.parse(raw));
  } catch {
    // Corrupted DB should not brick runtime. Recreate empty DB.
    const fresh = { hashes: [], fingerprints: [], _fpHashes: [] };
    try {
      writeDB(fresh);
    } catch {}
    return fresh;
  }
}

function isDbEmpty(db) {
  return !db || (db.hashes.length === 0 && db.fingerprints.length === 0);
}

function sameHashAlready(db, hash) {
  return Array.isArray(db?.hashes) && db.hashes.includes(hash);
}

function storeRug(hash, fp, db) {
  let changed = false;

  if (!db.hashes.includes(hash)) {
    db.hashes.push(hash);
    changed = true;
  }

  const fpHash = crypto.createHash("sha256").update(JSON.stringify(fp)).digest("hex");
  if (!db._fpHashes.includes(fpHash)) {
    db._fpHashes.push(fpHash);
    db.fingerprints.push(fp);
    changed = true;
  }

  if (changed) writeDB(db);
}

/* ================= BYTECODE NORMALIZATION ================= */
function fallbackTailStrip(code) {
  const minKeep = 2000; // keep at least 1000 bytes
  if (code.length <= 2 + minKeep) return code;
  const strip = 400; // 200 bytes tail strip
  return code.slice(0, Math.max(2 + minKeep, code.length - strip));
}

function stripSolidityMetadata(bytecodeHex) {
  const code = bytecodeHex?.toLowerCase();
  if (!code || code === "0x") return code;

  if ((code.length - 2) % 2 !== 0) return code;

  const buf = Buffer.from(code.slice(2), "hex");
  if (buf.length < 4) return code;

  const cborLen = buf.readUInt16BE(buf.length - 2);
  const cborStart = buf.length - 2 - cborLen;

  if (cborStart <= 0 || cborStart >= buf.length) return fallbackTailStrip(code);

  const first = buf[cborStart];
  const looksLikeCborMap = first >= 0xa0 && first <= 0xbf;
  if (!looksLikeCborMap) return fallbackTailStrip(code);

  const stripped = buf.slice(0, cborStart);
  return "0x" + stripped.toString("hex");
}

function normalize(bytecodeHex) {
  return stripSolidityMetadata(bytecodeHex);
}

/* ================= FINGERPRINT ================= */
function isPush(op) {
  return op >= 0x60 && op <= 0x7f;
}
function pushDataLen(op) {
  return op - 0x5f;
}

function fingerprint(bytecodeHex) {
  const code = bytecodeHex?.toLowerCase();
  if (!code || code === "0x") {
    return {
      opHist: {},
      risky: { delegatecall: false, create2: false, selfdestruct: false, create: false },
      selectors: { mint: false }
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

    const k = "0x" + op.toString(16).padStart(2, "0");
    opHist[k] = (opHist[k] || 0) + 1;

    if (op === 0xf4) delegatecall = true;
    if (op === 0xf5) create2 = true;
    if (op === 0xff) selfdestruct = true;
    if (op === 0xf0) create = true;

    if (isPush(op)) i += pushDataLen(op);
  }

  const mint = MINT_SELECTORS_HEX.some((s) => code.includes(s));

  return {
    opHist,
    risky: { delegatecall, create2, selfdestruct, create },
    selectors: { mint }
  };
}

/* ================= SIMILARITY ================= */
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

/* ================= MAIN ================= */
/**
 * Returns:
 * - 10 (clean)
 * - 5 (suspicious)
 * - 0 (confirmed match)
 * - null (rpc/code unreadable)
 *
 * IMPORTANT BEHAVIOR:
 * - If DB is empty: return 10 (do not store anything)
 * - Only store when confirmed via similarity >= CONFIRMED (or exact match already exists)
 */
export async function bytecodeHashSimilarityCheck(tokenAddress) {
  let addr;
  try {
    addr = ethers.getAddress(tokenAddress);
  } catch {
    return null;
  }

  let code;
  try {
    code = await rpcQueue.add(() => provider.getCode(addr));
  } catch {
    return null;
  }

  if (!code || code === "0x") return null;

  const cleanCode = normalize(code);
  const hash = crypto.createHash("sha256").update(cleanCode).digest("hex");
  const fp = fingerprint(cleanCode);

  const db = readDB();

  // Your rule: if DB is empty, treat as no threat and do not store.
  if (isDbEmpty(db)) return 10;

  // Exact known rug hash -> confirmed
  if (sameHashAlready(db, hash)) return 0;

  // Similarity against known fingerprints
  let bestSim = 0;
  for (const knownFp of db.fingerprints) {
    if (!knownFp || typeof knownFp !== "object") continue;

    const sim = cosineSimilarity(fp.opHist, knownFp.opHist || {});
    if (sim > bestSim) bestSim = sim;

    if (sim >= SIMILARITY_CONFIRMED) {
      storeRug(hash, fp, db);
      return 0;
    }
  }

  if (bestSim >= SIMILARITY_SUSPICIOUS) return 5;
  return 10;
}