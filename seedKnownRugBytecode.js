// ingestRugBytecode.js
// GUARANTEED: Stores bytecode for EVERY token address you pass (rug samples you observed).
// No detection, no heuristics, no rejecting.
//
// Usage:
//   node ingestRugBytecode.js 0xToken1 0xToken2 0xToken3
//
// Env:
//   BSC_RPC=...
//   KNOWN_RUG_DB=./known_rug_bytecodes.json   (optional)

import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= RPC CONFIG ================= */
const RPC_URL = process.env.BSC_RPC;
if (!RPC_URL) throw new Error("BSC_RPC not set in .env");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 1 });

/* ================= CONFIG ================= */
const KNOWN_RUGS = process.env.KNOWN_RUG_DB || "./known_rug_bytecodes.json";

/* ================= DB IO ================= */
function ensureDbShape(obj) {
  if (!obj || typeof obj !== "object") return { hashes: [], fingerprints: [], _fpHashes: [] };
  if (!Array.isArray(obj.hashes)) obj.hashes = [];
  if (!Array.isArray(obj.fingerprints)) obj.fingerprints = [];
  if (!Array.isArray(obj._fpHashes)) obj._fpHashes = [];
  return obj;
}

function readDB() {
  try {
    if (!fs.existsSync(KNOWN_RUGS)) return { hashes: [], fingerprints: [], _fpHashes: [] };
    const raw = fs.readFileSync(KNOWN_RUGS, "utf8");
    if (!raw || !raw.trim()) return { hashes: [], fingerprints: [], _fpHashes: [] };
    return ensureDbShape(JSON.parse(raw));
  } catch {
    return { hashes: [], fingerprints: [], _fpHashes: [] };
  }
}

function writeDB(db) {
  const dir = path.dirname(KNOWN_RUGS);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${KNOWN_RUGS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, KNOWN_RUGS);
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
  return changed;
}

/* ================= BYTECODE NORMALIZATION ================= */
function fallbackTailStrip(code) {
  const minKeep = 2000;
  if (code.length <= 2 + minKeep) return code;
  const strip = 400;
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
      risky: { delegatecall: false, create2: false, selfdestruct: false, create: false }
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

  return { opHist, risky: { delegatecall, create2, selfdestruct, create } };
}

/* ================= INGEST (GUARANTEED STORE) ================= */
async function ingestOne(tokenAddress) {
  let addr;
  try {
    addr = ethers.getAddress(tokenAddress);
  } catch {
    console.log(`SKIP invalid address: ${tokenAddress}`);
    return { ok: false, reason: "INVALID_ADDRESS" };
  }

  let code;
  try {
    code = await rpcQueue.add(() => provider.getCode(addr));
  } catch (e) {
    console.log(`FAIL getCode: ${addr} -> ${e?.message || String(e)}`);
    return { ok: false, reason: "RPC_ERROR" };
  }

  if (!code || code === "0x") {
    console.log(`SKIP no bytecode at: ${addr}`);
    return { ok: false, reason: "NO_BYTECODE" };
  }

  const cleanCode = normalize(code);
  const hash = crypto.createHash("sha256").update(cleanCode).digest("hex");
  const fp = fingerprint(cleanCode);

  const db = readDB();
  const changed = storeRug(hash, fp, db);

  console.log(`INGESTED: ${addr}`);
  console.log(`  hash: ${hash}`);
  console.log(`  stored: ${changed ? "YES" : "NO (already present)"}`);

  return { ok: true, stored: changed, hash };
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  if (args.length === 0) {
    console.log("Usage: node ingestRugBytecode.js 0xToken1 0xToken2 ...");
    process.exit(1);
  }

  for (const a of args) {
    await ingestOne(a);
  }

  console.log(`Done. DB path: ${KNOWN_RUGS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});