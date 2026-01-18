// securitycheck2.js
// No veto anywhere.
// Bytecode contributes points only when known_rug_bytecodes.json is NOT empty.
// Sell restriction heuristics removed completely.
// Replaced with control risk (owner privileges + mutable settings + upgradeability).
// Scoring:
// - ownershipScore: 0..30
// - bytecodeScore: 0..15 (neutral 0 if DB empty or unavailable)
// - devWalletScore: 0..10
// - sizeScore: 0..5
// - controlRiskScore: 0..10
// Total max = 70, pass threshold = 58
//
// Patch included:
// if upgradeable + hasAdmin => cap ownershipScore to max 10

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

const MAX_SCORE = 70;
const PASS_THRESHOLD = 50;

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
    return true;
  }
}

function isNonZeroAddressHex32(slotVal) {
  if (!slotVal || typeof slotVal !== "string") return false;
  const v = slotVal.toLowerCase();
  if (!v.startsWith("0x") || v.length !== 66) return false;
  return !/^0x0{64}$/.test(v);
}

function slotToAddress(slotVal) {
  if (!slotVal || typeof slotVal !== "string") return null;
  const v = slotVal.toLowerCase();
  if (!v.startsWith("0x") || v.length !== 66) return null;
  const addr = "0x" + v.slice(26);
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    return null;
  }
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

/* ================= CORE SCORES ================= */
/**
 * Ownership score (0..30)
 * 30 = owner() exists and is 0x0 or 0xdead
 * 15 = owner() missing or reverts (neutral)
 * 0  = owner() exists and is some active address
 */
async function ownershipScore30(tokenAddr) {
  return withRpc(async (prov) => {
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, prov);
    try {
      const owner = norm(await erc.owner());
      if (!owner) return 15;
      if (owner === ZERO || owner === DEAD) return 30;
      return 0;
    } catch {
      return 15;
    }
  });
}

/**
 * Dev wallet score (0..10)
 * Uses owner() as proxy.
 * 10 = owner holds <= 5% supply
 * 5  = owner() missing/reverts
 * 0  = owner holds > 5% supply OR supply invalid
 */
async function devWalletScore10(tokenAddr) {
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
 * Size score (0..5)
 */
async function sizeScore5(tokenAddr) {
  return withRpc(async (prov) => {
    const code = await prov.getCode(tokenAddr);
    if (!code || code === "0x") return 0;
    const byteLen = (code.length - 2) / 2;
    return byteLen < 24000 ? 5 : 0;
  });
}

/**
 * Bytecode score (0..15), NO VETO.
 * If known_rug DB is empty => score 0 (neutral).
 * If checker unavailable => score 0 (neutral).
 * Mapping from bytecodeHashSimilarityCheck:
 * - 10 => 15 points
 * - 5  => 7 points
 * - 0  => 0 points
 * Takes the worse (min) of input token and resolved token.
 */
async function bytecodeScore15NoVeto(tokenArg, tokenResolved) {
  const dbEmpty = readDbIsEmpty();
  if (dbEmpty) {
    return { score: 0, dbEmpty: true, input: null, resolved: null };
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

  const normScore = (x) => (x === 10 || x === 5 || x === 0 ? x : null);

  bcInput = normScore(bcInput);
  bcResolved = normScore(bcResolved);

  if (bcInput === null && bcResolved === null) {
    return { score: 0, dbEmpty: false, input: null, resolved: null };
  }

  const worst = Math.min(bcInput ?? 10, bcResolved ?? 10);

  const map = (v) => {
    if (v === 10) return 15;
    if (v === 5) return 7;
    return 0;
  };

  return { score: map(worst), dbEmpty: false, input: bcInput, resolved: bcResolved };
}

/**
 * Control risk score (0..10)
 * Focus: upgradeability + presence of mutable settings getters.
 * Also returns hasAdmin signal when EIP-1967 admin slot is set to non-zero.
 */
async function controlRiskScore10(tokenAddr) {
  return withRpc(async (prov) => {
    let score = 10;

    const EIP1967_IMPLEMENTATION_SLOT =
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const EIP1967_ADMIN_SLOT =
      "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    const EIP1967_BEACON_SLOT =
      "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

    let implSlot = null;
    let adminSlot = null;
    let beaconSlot = null;

    try {
      [implSlot, adminSlot, beaconSlot] = await Promise.all([
        prov.getStorage(tokenAddr, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
        prov.getStorage(tokenAddr, EIP1967_ADMIN_SLOT).catch(() => null),
        prov.getStorage(tokenAddr, EIP1967_BEACON_SLOT).catch(() => null)
      ]);
    } catch {
      // ignore
    }

    const upgradeable =
      isNonZeroAddressHex32(implSlot) ||
      isNonZeroAddressHex32(adminSlot) ||
      isNonZeroAddressHex32(beaconSlot);

    const adminAddr = slotToAddress(adminSlot);
    const hasAdmin = Boolean(adminAddr && adminAddr !== ZERO);

    if (upgradeable) score -= 4;

    const getterAbis = [
      "function tradingEnabled() view returns (bool)",
      "function swapEnabled() view returns (bool)",
      "function limitsInEffect() view returns (bool)",
      "function maxTxAmount() view returns (uint256)",
      "function maxWalletAmount() view returns (uint256)",
      "function buyTax() view returns (uint256)",
      "function sellTax() view returns (uint256)",
      "function totalFees() view returns (uint256)",
      "function transferDelayEnabled() view returns (bool)",
      "function cooldownEnabled() view returns (bool)"
    ];

    const c = new ethers.Contract(tokenAddr, getterAbis, prov);

    let hits = 0;

    const calls = [
      c.tradingEnabled?.staticCall?.().then(() => hits++).catch(() => {}),
      c.swapEnabled?.staticCall?.().then(() => hits++).catch(() => {}),
      c.limitsInEffect?.staticCall?.().then(() => hits++).catch(() => {}),
      c.maxTxAmount?.staticCall?.().then(() => hits++).catch(() => {}),
      c.maxWalletAmount?.staticCall?.().then(() => hits++).catch(() => {}),
      c.buyTax?.staticCall?.().then(() => hits++).catch(() => {}),
      c.sellTax?.staticCall?.().then(() => hits++).catch(() => {}),
      c.totalFees?.staticCall?.().then(() => hits++).catch(() => {}),
      c.transferDelayEnabled?.staticCall?.().then(() => hits++).catch(() => {}),
      c.cooldownEnabled?.staticCall?.().then(() => hits++).catch(() => {})
    ];

    await Promise.allSettled(calls);

    if (hits >= 6) score -= 4;
    else if (hits >= 3) score -= 2;

    if (score < 0) score = 0;
    if (score > 10) score = 10;

    return { score, upgradeable, hasAdmin, getterHits: hits };
  });
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

  const [own30, dev10, size5, bc15, control10] = await Promise.all([
    ownershipScore30(tokenFromPair).catch(() => 0),
    devWalletScore10(tokenFromPair).catch(() => 0),
    sizeScore5(tokenFromPair).catch(() => 0),
    bytecodeScore15NoVeto(tokenArg, tokenFromPair).catch(() => ({
      score: 0,
      dbEmpty: true,
      input: null,
      resolved: null
    })),
    controlRiskScore10(tokenFromPair).catch(() => ({
      score: 0,
      upgradeable: null,
      hasAdmin: null,
      getterHits: 0
    }))
  ]);

  let ownershipScore = Number.isFinite(Number(own30)) ? Number(own30) : 0;
  const devWalletScore = Number.isFinite(Number(dev10)) ? Number(dev10) : 0;
  const sizeScore = Number.isFinite(Number(size5)) ? Number(size5) : 0;
  const bytecodeScore = Number.isFinite(Number(bc15?.score)) ? Number(bc15.score) : 0;
  const controlRiskScore = Number.isFinite(Number(control10?.score)) ? Number(control10.score) : 0;

  // PATCH: proxy admin overrides "owner renounced" comfort
  if (control10?.upgradeable && control10?.hasAdmin) {
    ownershipScore = Math.min(ownershipScore, 10);
  }

  const score = ownershipScore + devWalletScore + sizeScore + bytecodeScore + controlRiskScore;
  const pass = score >= PASS_THRESHOLD;

  const reasons = [];
  if (tokenMismatch) reasons.push("TOKEN_MISMATCH_INPUT_VS_PAIR");

  if (ownershipScore === 0) reasons.push("OWNER_ACTIVE");
  if (devWalletScore === 0) reasons.push("DEV_WALLET_SUPPLY_TOO_HIGH");
  if (sizeScore === 0) reasons.push("BYTECODE_TOO_LARGE");

  if (bc15?.dbEmpty) reasons.push("KNOWN_RUG_DB_EMPTY_BYTECODE_NEUTRAL");
  else if ((bc15?.input ?? 10) < 10 || (bc15?.resolved ?? 10) < 10) reasons.push("BYTECODE_SIMILARITY_SIGNAL");

  if (control10?.upgradeable) reasons.push("UPGRADEABLE_SIGNAL");
  if (control10?.hasAdmin) reasons.push("PROXY_ADMIN_SIGNAL");
  if ((control10?.getterHits ?? 0) >= 6) reasons.push("MANY_MUTABLE_SETTINGS_GETTERS");

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
      ownershipScore, // 0..30 (may be capped to 10 by patch)
      bytecodeScore, // 0..15
      devWalletScore, // 0..10
      sizeScore, // 0..5
      controlRiskScore // 0..10
    },
    reasons,
    details: {
      bytecodeSimilarity: {
        dbEmpty: bc15?.dbEmpty ?? true,
        input: bc15?.input ?? null,
        resolved: bc15?.resolved ?? null
      },
      controlRisk: {
        upgradeable: control10?.upgradeable ?? null,
        hasAdmin: control10?.hasAdmin ?? null,
        getterHits: control10?.getterHits ?? 0
      }
    }
  };
}
