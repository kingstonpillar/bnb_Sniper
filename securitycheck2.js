// securitycheck2.js (no veto, bytecode only contributes points, empty DB => bytecode contributes 0)
// Rules implemented exactly as requested:
// - No veto anywhere (no early-fail, no "BYTECODE_RUG_MATCH" hard stop)
// - bytecodeHashSimilarityCheck contributes points only
// - If known_rug_bytecodes.json is missing/empty, bytecodeScore = 0 and other logic still scores
// - If bytecodeHashSimilarityCheck returns null/unavailable, treat as 0 points (not a fail)

import "dotenv/config";
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { bytecodeHashSimilarityCheck } from "./bytecodeCheck.js";

/* ================= CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_51, process.env.RPC_URL_61, process.env.RPC_URL_7].filter(Boolean);
if (RPC_URLS.length < 2) throw new Error("At least 2 RPC URLs required");

const queue = new PQueue({ interval: 3000, intervalCap: 4, concurrency: 1 });

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
      return await queue.add(() => fn(provider));
    } catch (e) {
      lastErr = e;
      rotateRpc();
    }
  }
  throw lastErr;
}

/* ================= CONSTANTS ================= */
const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase();
const DEAD = "0x000000000000000000000000000000000000dEaD".toLowerCase();
const ZERO = ethers.ZeroAddress.toLowerCase();

// Score model (unchanged)
const MAX_SCORE = 70;
const PASS_THRESHOLD = 58;

// Rug DB path (must match bytecodeCheck.js)
const KNOWN_RUGS = process.env.KNOWN_RUG_DB || "./known_rug_bytecodes.json";

/* ================= ABIS ================= */
const PAIR_ABI = ["function token0() view returns(address)", "function token1() view returns(address)"];

const ERC20_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function owner() view returns(address)"
];

/* ================= HELPERS ================= */
function norm(a) {
  try {
    return ethers.getAddress(a).toLowerCase();
  } catch {
    return null;
  }
}

function toBigIntSafe(x) {
  try {
    return BigInt(x);
  } catch {
    return 0n;
  }
}

function pctBps(part, total) {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total);
}

function readDbIsEmpty() {
  try {
    if (!fs.existsSync(KNOWN_RUGS)) return true;
    const raw = fs.readFileSync(KNOWN_RUGS, "utf8");
    if (!raw || !raw.trim()) return true;
    const j = JSON.parse(raw);
    const hashesLen = Array.isArray(j?.hashes) ? j.hashes.length : 0;
    const fpsLen = Array.isArray(j?.fingerprints) ? j.fingerprints.length : 0;
    return hashesLen === 0 && fpsLen === 0;
  } catch {
    // If DB unreadable/corrupt, treat as empty so we don't block scoring
    return true;
  }
}

/**
 * Extract 4-byte selectors by scanning for PUSH4 (0x63) patterns.
 */
function extractSelectors(bytecodeHex) {
  const code = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;
  const bytes = code.match(/.{2}/g) || [];
  const selectors = new Set();

  for (let i = 0; i < bytes.length - 5; i++) {
    if (bytes[i] === "63") {
      const sel = bytes[i + 1] + bytes[i + 2] + bytes[i + 3] + bytes[i + 4];
      selectors.add(sel);
      i += 4;
    }
  }
  return selectors;
}

function hasOpcode(bytecodeHex, opcodeHex) {
  const code = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;
  return code.toLowerCase().includes(opcodeHex.toLowerCase());
}

/**
 * Basic proxy pattern checks:
 * - EIP-1167 minimal proxy pattern
 * - delegatecall opcode present (0xf4) as a weak signal
 */
function proxyHeuristics(bytecodeHex) {
  const code = bytecodeHex.toLowerCase();
  const minimalProxy =
    code.includes("363d3d373d3d3d363d73") && code.includes("5af43d82803e903d91602b57fd5bf3");
  const hasDelegatecall = hasOpcode(code, "f4");
  return { minimalProxy, hasDelegatecall };
}

/* ================= TOKEN / PAIR RESOLUTION ================= */
async function resolveTokenFromPair(pairAddr, prov) {
  const pair = new ethers.Contract(pairAddr, PAIR_ABI, prov);
  const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
  const a0 = norm(t0);
  const a1 = norm(t1);
  if (!a0 || !a1) throw new Error("PAIR_BAD_TOKENS");
  if (a0 === WBNB) return a1;
  if (a1 === WBNB) return a0;
  throw new Error("PAIR_NOT_WBNB");
}

async function isContract(addr) {
  const a = norm(addr);
  if (!a) return false;
  return withRpc(async (prov) => {
    const code = await prov.getCode(a);
    return Boolean(code && code !== "0x");
  });
}

/* ================= CORE CHECKS ================= */
/**
 * Ownership renounce score (0..10)
 * 10 = owner() exists and is 0x0 or 0xdead
 * 5  = owner() missing or reverts (neutral)
 * 0  = owner() exists and is some active address
 */
async function ownershipScoreFromToken(tokenAddr) {
  return withRpc(async (prov) => {
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, prov);
    try {
      const owner = norm(await erc.owner());
      if (!owner) return 5;
      if (owner === ZERO || owner === DEAD) return 10;
      return 0;
    } catch {
      return 5;
    }
  });
}

/**
 * Dev wallet concentration score (0..10)
 */
async function devWalletScoreFromToken(tokenAddr) {
  return withRpc(async (prov) => {
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, prov);

    let owner;
    try {
      owner = norm(await erc.owner());
    } catch {
      return 5;
    }
    if (!owner) return 5;

    let supply;
    let ownerBal;
    try {
      const [ts, bal] = await Promise.all([erc.totalSupply(), erc.balanceOf(owner)]);
      supply = toBigIntSafe(ts);
      ownerBal = toBigIntSafe(bal);
    } catch {
      return 5;
    }

    if (supply <= 0n) return 0;
    const ownerBps = pctBps(ownerBal, supply);
    return ownerBps <= 500 ? 10 : 0;
  });
}

/**
 * Contract size score (0..5)
 */
async function sizeScoreFromToken(tokenAddr) {
  return withRpc(async (prov) => {
    const code = await prov.getCode(tokenAddr);
    if (!code || code === "0x") return 0;
    const byteLen = (code.length - 2) / 2;
    return byteLen < 24000 ? 5 : 0;
  });
}

/**
 * Static sell restriction / anti-bot heuristic score (0..15)
 */
async function sellRestrictionHeuristicScore(tokenAddr) {
  return withRpc(async (prov) => {
    const code = await prov.getCode(tokenAddr);
    if (!code || code === "0x") return 0;

    let score = 15;

    const { minimalProxy, hasDelegatecall } = proxyHeuristics(code);
    if (minimalProxy) score -= 6;
    if (hasDelegatecall) score -= 4;

    if (hasOpcode(code, "ff")) score -= 6; // SELFDESTRUCT signal
    if (hasOpcode(code, "f5")) score -= 3; // CREATE2 signal

    const sels = extractSelectors(code);

    const suspiciousSelectors = [
      "a9059cbb",
      "095ea7b3",
      "23b872dd",
      "8f32d59b",
      "6e3f7b7c",
      "5c11d795",
      "1a9c3bde"
    ];

    let hits = 0;
    for (const s of suspiciousSelectors) if (sels.has(s)) hits++;

    if (hits >= 4) score -= 6;
    else if (hits === 3) score -= 4;
    else if (hits === 2) score -= 2;

    if (score < 0) score = 0;
    if (score > 15) score = 15;
    return score;
  });
}

/**
 * Time trap score (0..10)
 */
async function timeTrapHeuristicScore(tokenAddr) {
  return withRpc(async (prov) => {
    const code = await prov.getCode(tokenAddr);
    if (!code || code === "0x") return 0;

    let score = 10;

    const { minimalProxy, hasDelegatecall } = proxyHeuristics(code);
    if (minimalProxy) score -= 4;
    if (hasDelegatecall) score -= 2;

    const sels = extractSelectors(code);

    const gatingSelectors = ["8f32d59b", "7a9e5e4b", "f2fde38b"];

    let hits = 0;
    for (const s of gatingSelectors) if (sels.has(s)) hits++;

    if (hits >= 2) score -= 4;
    else if (hits === 1) score -= 2;

    if (score < 0) score = 0;
    return score;
  });
}

/* ================= BYTECODE SCORE (NO VETO) ================= */
/**
 * - If DB is empty => bytecodeScore = 0 (do not penalize)
 * - If bytecodeHashSimilarityCheck returns null => bytecodeScore = 0 (do not penalize)
 * - Else map:
 *     10 => 20 points
 *      5 => 10 points
 *      0 => 0 points
 */
async function bytecodeScoreNoVeto(tokenArg, tokenResolved) {
  const dbEmpty = readDbIsEmpty();
  if (dbEmpty) {
    return {
      bytecodeScore: 0,
      bcInput: null,
      bcResolved: null,
      dbEmpty: true
    };
  }

  let bcInput = null;
  let bcResolved = null;

  try {
    [bcInput, bcResolved] = await Promise.all([
      bytecodeHashSimilarityCheck(tokenArg).catch(() => null),
      bytecodeHashSimilarityCheck(tokenResolved).catch(() => null)
    ]);
  } catch {
    bcInput = null;
    bcResolved = null;
  }

  const normScore = (x) => {
    if (x === 10 || x === 5 || x === 0) return x;
    return null; // includes null/unavailable/invalid
  };

  bcInput = normScore(bcInput);
  bcResolved = normScore(bcResolved);

  if (bcInput === null && bcResolved === null) {
    return {
      bytecodeScore: 0,
      bcInput: null,
      bcResolved: null,
      dbEmpty: false
    };
  }

  // "worse" outcome means the smaller number (0 is worst, 10 best)
  const worst = Math.min(bcInput ?? 10, bcResolved ?? 10);
  const bytecodeScore = worst * 2; // 0/10/20

  return { bytecodeScore, bcInput, bcResolved, dbEmpty: false };
}

/* ================= MAIN FUNCTION ================= */
export async function securitySafety(pairAddress, tokenMint) {
  const pair = norm(pairAddress);
  const tokenArg = norm(tokenMint);

  if (!pair || !tokenArg) {
    return {
      ok: false,
      pass: false,
      reason: "INVALID_INPUT",
      pair: pair || null,
      token: null,
      tokenMint: tokenArg || null,
      tokenMismatch: false,
      score: 0,
      maxScore: MAX_SCORE,
      passThreshold: PASS_THRESHOLD,
      breakdown: null,
      reasons: ["INVALID_INPUT"],
      details: { pairAddress, tokenMint }
    };
  }

  // Ensure pair is contract
  let pairOk = false;
  try {
    pairOk = await isContract(pair);
  } catch (e) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_CONTRACT_CHECK_FAILED",
      pair,
      token: null,
      tokenMint: tokenArg,
      tokenMismatch: false,
      score: 0,
      maxScore: MAX_SCORE,
      passThreshold: PASS_THRESHOLD,
      breakdown: null,
      reasons: ["PAIR_CONTRACT_CHECK_FAILED"],
      details: { error: e?.message || String(e) }
    };
  }

  if (!pairOk) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_NOT_CONTRACT",
      pair,
      token: null,
      tokenMint: tokenArg,
      tokenMismatch: false,
      score: 0,
      maxScore: MAX_SCORE,
      passThreshold: PASS_THRESHOLD,
      breakdown: null,
      reasons: ["PAIR_NOT_CONTRACT"],
      details: { pairAddress: pair }
    };
  }

  // Resolve token from pair
  let tokenFromPair = null;
  try {
    tokenFromPair = await withRpc(async (prov) => resolveTokenFromPair(pair, prov));
    tokenFromPair = norm(tokenFromPair);
  } catch (e) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_TOKEN_RESOLVE_FAILED",
      pair,
      token: null,
      tokenMint: tokenArg,
      tokenMismatch: false,
      score: 0,
      maxScore: MAX_SCORE,
      passThreshold: PASS_THRESHOLD,
      breakdown: null,
      reasons: ["PAIR_TOKEN_RESOLVE_FAILED"],
      details: { error: e?.message || String(e) }
    };
  }

  if (!tokenFromPair) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_TOKEN_INVALID",
      pair,
      token: null,
      tokenMint: tokenArg,
      tokenMismatch: false,
      score: 0,
      maxScore: MAX_SCORE,
      passThreshold: PASS_THRESHOLD,
      breakdown: null,
      reasons: ["PAIR_TOKEN_INVALID"],
      details: { tokenFromPairRaw: tokenFromPair }
    };
  }

  const tokenMismatch = tokenArg !== tokenFromPair;

  // Bytecode score (NO VETO)
  const bc = await bytecodeScoreNoVeto(tokenArg, tokenFromPair);

  // Remaining heuristics
  let devScore = 0;
  let ownScore = 0;
  let sizeScore = 0;
  let sellRestrictScore = 0;
  let timeScore = 0;

  try {
    [devScore, ownScore, sizeScore, sellRestrictScore, timeScore] = await Promise.all([
      devWalletScoreFromToken(tokenFromPair).catch(() => 0),
      ownershipScoreFromToken(tokenFromPair).catch(() => 0),
      sizeScoreFromToken(tokenFromPair).catch(() => 0),
      sellRestrictionHeuristicScore(tokenFromPair).catch(() => 0),
      timeTrapHeuristicScore(tokenFromPair).catch(() => 0)
    ]);
  } catch {
    // keep defaults
  }

  devScore = Number.isFinite(Number(devScore)) ? Number(devScore) : 0;
  ownScore = Number.isFinite(Number(ownScore)) ? Number(ownScore) : 0;
  sizeScore = Number.isFinite(Number(sizeScore)) ? Number(sizeScore) : 0;
  sellRestrictScore = Number.isFinite(Number(sellRestrictScore)) ? Number(sellRestrictScore) : 0;
  timeScore = Number.isFinite(Number(timeScore)) ? Number(timeScore) : 0;

  const score =
    (Number.isFinite(bc.bytecodeScore) ? bc.bytecodeScore : 0) +
    devScore +
    ownScore +
    sizeScore +
    sellRestrictScore +
    timeScore;

  const pass = score >= PASS_THRESHOLD;

  const reasons = [];
  if (tokenMismatch) reasons.push("TOKEN_MISMATCH_INPUT_VS_PAIR");

  // Informational reasons only (no veto)
  if (bc.dbEmpty) reasons.push("KNOWN_RUG_DB_EMPTY_BYTECODE_NEUTRAL");
  else if ((bc.bcInput ?? 10) < 10 || (bc.bcResolved ?? 10) < 10) reasons.push("BYTECODE_SIMILARITY_SIGNAL");

  if (ownScore === 0) reasons.push("OWNER_NOT_RENOUNCED");
  if (devScore === 0) reasons.push("DEV_WALLET_SUPPLY_TOO_HIGH");
  if (sellRestrictScore <= 6) reasons.push("SELL_RESTRICTION_SIGNALS_HIGH");
  if (timeScore <= 4) reasons.push("TIME_GATING_SIGNALS_HIGH");
  if (sizeScore === 0) reasons.push("BYTECODE_TOO_LARGE");

  return {
    ok: true,
    pass,
    reason: pass ? "PASS" : "FAIL",
    pair,
    token: tokenFromPair,
    tokenMint: tokenArg,
    tokenMismatch,
    score,
    maxScore: MAX_SCORE,
    passThreshold: PASS_THRESHOLD,
    breakdown: {
      bytecodeScore: bc.bytecodeScore,
      devWalletScore: devScore,
      ownershipScore: ownScore,
      sizeScore,
      sellRestrictionHeuristicScore: sellRestrictScore,
      timeTrapHeuristicScore: timeScore
    },
    reasons,
    details: {
      bytecodeSimilarity: {
        dbEmpty: bc.dbEmpty,
        input: bc.bcInput,
        resolved: bc.bcResolved
      }
    }
  };
}
