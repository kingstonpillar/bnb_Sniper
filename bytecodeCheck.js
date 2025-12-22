// bytecodeCheck.js
import crypto from "crypto";
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

/* ================= RPC CONFIG ================= */
const RPC_URL = process.env.BSC_RPC;
if (!RPC_URL) throw new Error("BSC_RPC not set in .env");

const provider = new ethers.JsonRpcProvider(RPC_URL);

// limit RPC calls: max 5 per second
const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 5
});

/* ================= CONFIG ================= */
const KNOWN_RUGS = "./known_rug_bytecodes.json";

/* ================= HELPERS ================= */
function readDB() {
  if (!fs.existsSync(KNOWN_RUGS)) {
    return { hashes: [], fingerprints: [] };
  }
  return JSON.parse(fs.readFileSync(KNOWN_RUGS, "utf8"));
}

function writeDB(db) {
  fs.writeFileSync(KNOWN_RUGS, JSON.stringify(db, null, 2));
}

/* ================= BYTECODE NORMALIZATION ================= */
function normalize(code) {
  return code.length > 172 ? code.slice(0, code.length - 172) : code;
}

/* ================= OPCODE FINGERPRINT ================= */
function fingerprint(bytecode) {
  return bytecode
    .slice(2)
    .match(/.{2}/g)
    .map(b => parseInt(b, 16))
    .filter(op => op >= 0x60 && op <= 0x7f)
    .join(",");
}

/* ================= SIMILARITY ================= */
function similarity(a, b) {
  const A = a.split(",");
  const B = b.split(",");
  const len = Math.min(A.length, B.length);
  if (!len) return 0;

  let same = 0;
  for (let i = 0; i < len; i++) {
    if (A[i] === B[i]) same++;
  }
  return same / len;
}

/* ================= MAIN ================= */
/**
 * Returns score:
 * 10 = clean
 * 5  = suspicious
 * 0  = confirmed rug
 */
export async function bytecodeHashSimilarityCheck(tokenMint) {
  const code = await rpcQueue.add(() => provider.getCode(tokenMint));
  if (code === "0x") return 0;

  const cleanCode = normalize(code);
  const hash = crypto.createHash("sha256").update(cleanCode).digest("hex");
  const fp = fingerprint(cleanCode);

  const db = readDB();

  /* -------- Exact match -------- */
  if (db.hashes.includes(hash)) {
    return 0;
  }

  /* -------- Similarity -------- */
  for (const knownFp of db.fingerprints) {
    const s = similarity(fp, knownFp);

    if (s >= 0.85) {
      storeRug(hash, fp, db);
      console.log(` Rug similarity ${(s * 100).toFixed(1)}%  stored`);
      return 0;
    }

    if (s >= 0.7) {
      return 5;
    }
  }

  return 10;
}

/* ================= STORE ================= */
function storeRug(hash, fp, db) {
  let changed = false;

  if (!db.hashes.includes(hash)) {
    db.hashes.push(hash);
    changed = true;
  }

  if (!db.fingerprints.includes(fp)) {
    db.fingerprints.push(fp);
    changed = true;
  }

  if (changed) writeDB(db);
}