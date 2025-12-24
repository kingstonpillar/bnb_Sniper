// bytecodeCheck.js
import dotenv from "dotenv";
dotenv.config();
import crypto from "crypto";
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= RPC CONFIG ================= */
const RPC_URL = process.env.BSC_RPC;
if (!RPC_URL) throw new Error("BSC_RPC not set in .env");

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Limit RPC calls: max 5 per second
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
  // Strip metadata and constructor args at the end
  return code.length > 200 ? code.slice(0, code.length - 200) : code;
}

/* ================= OPCODE FINGERPRINT ================= */
function fingerprint(bytecode) {
  const ops = bytecode
    .slice(2)
    .match(/.{2}/g)
    .map(b => parseInt(b, 16));

  const pushOps = ops.filter(op => op >= 0x60 && op <= 0x7f); // PUSH1–PUSH32
  const riskyOps = ops.filter(op => [0xf0, 0xff, 0xf4, 0xf5].includes(op)); // callcode, delegatecall, selfdestruct, create2

  return pushOps.join(",") + "|" + riskyOps.join(",");
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

/* ================= MAIN ================= */
/**
 * Returns score:
 * 10 = clean
 * 5  = suspicious
 * 0  = confirmed rug / risky
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
    return 0; // known rug
  }

  /* -------- Similarity & risk opcodes -------- */
  const [pushOps, riskOps] = fp.split("|");
  for (const knownFp of db.fingerprints) {
    const [knownPush] = knownFp.split("|");
    const s = similarity(pushOps, knownPush);

    if (s >= 0.85 || riskOps.split(",").filter(Boolean).length > 0) {
      storeRug(hash, fp, db);
      console.log(`⚠️ Rug similarity ${(s * 100).toFixed(1)}% or risky opcode detected, stored`);
      return 0; // confirmed rug / high risk
    }

    if (s >= 0.7) {
      return 5; // suspicious
    }
  }

  return 10; // clean
}