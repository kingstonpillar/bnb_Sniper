// file: securityPerfect.js
import { config } from "dotenv";
import PQueue from "p-queue";
import { ethers } from "ethers";
config();

/* ================= RPC CONFIG ================= */
const RPC_READ = process.env.RPC_READ;
const RPC_LOGS = process.env.RPC_LOGS;

if (!RPC_READ) throw new Error("RPC_READ missing in .env");
if (!RPC_LOGS) throw new Error("RPC_LOGS missing in .env");

const providerRead = new ethers.JsonRpcProvider(RPC_READ);
const providerLogs = new ethers.JsonRpcProvider(RPC_LOGS);

/* ================= RATE LIMIT ================= */
const readQueue = new PQueue({
  interval: 1000,
  intervalCap: 5,
  concurrency: 1,
  carryoverConcurrencyCount: true
});

const logsQueue = new PQueue({
  interval: 1000,
  intervalCap: 5,
  concurrency: 1,
  carryoverConcurrencyCount: true
});

/* ================= CONSTANTS ================= */
const WBNB_ADDRESS = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase();
const DEAD = "0x000000000000000000000000000000000000dead";
const ZERO = ethers.ZeroAddress.toLowerCase();

const MIN_SECURITY_SCORE = Number(process.env.MIN_SECURITY_SCORE || 70);

const MIN_LIQUIDITY_BNB = Number(process.env.MIN_LIQUIDITY_BNB || 24);
const ANTIBOT_LOOKBACK_BLOCKS = Number(process.env.ANTIBOT_LOOKBACK_BLOCKS || 2_000);



/* ================= ABIs ================= */
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)"
];

const ERC20_EXTRA_ABI = ["function balanceOf(address) view returns (uint256)"];

const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];

/* ================= HELPERS ================= */
function scoreBool(cond, val) {
  return cond ? val : 0;
}

async function safe(queue, fn) {
  try {
    return await queue.add(fn);
  } catch {
    return null;
  }
}

function norm(a) {
  try {
    return ethers.getAddress(a).toLowerCase();
  } catch {
    return null;
  }
}

async function isContract(addr, prov) {
  const a = norm(addr);
  if (!a) return false;
  const code = await safe(readQueue, () => prov.getCode(a));
  return Boolean(code && code !== "0x");
}

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/* ================= TOKEN RESOLUTION ================= */
async function resolveTokenFromPair(pair, prov) {
  const p = norm(pair);
  if (!p) throw new Error("PAIR_INVALID");

  const lp = new ethers.Contract(p, PAIR_ABI, prov);
  const [t0Raw, t1Raw] = await Promise.all([lp.token0(), lp.token1()]);
  const t0 = norm(t0Raw);
  const t1 = norm(t1Raw);
  if (!t0 || !t1) throw new Error("PAIR_BAD_TOKENS");

  if (t0 === WBNB_ADDRESS) return t1;
  if (t1 === WBNB_ADDRESS) return t0;

  throw new Error("PAIR_NOT_WBNB");
}


/* ================= LIQUIDITY CHECK (BNB reserve) ================= */
async function checkLiquidity(pair, token) {
  const p = norm(pair);
  const t = norm(token);
  if (!p || !t) return { ok: false, score: 0, liquidityBNB: 0, reason: "BAD_INPUT" };

  const pairContract = new ethers.Contract(p, PAIR_ABI, providerRead);

  const reserves = await safe(readQueue, () => pairContract.getReserves());
  if (!reserves) return { ok: false, score: 0, liquidityBNB: 0, reason: "RESERVES_UNREADABLE" };

  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);

  const token0 = norm(await safe(readQueue, () => pairContract.token0()));
  const token1 = norm(await safe(readQueue, () => pairContract.token1()));
  if (!token0 || !token1) return { ok: false, score: 0, liquidityBNB: 0, reason: "PAIR_TOKENS_UNREADABLE" };

  let wbnbReserve = 0n;
  if (token0 === WBNB_ADDRESS) wbnbReserve = reserve0;
  else if (token1 === WBNB_ADDRESS) wbnbReserve = reserve1;
  else return { ok: false, score: 0, liquidityBNB: 0, reason: "PAIR_NOT_WBNB" };

  const liquidityBNB = Number(ethers.formatUnits(wbnbReserve, 18));

  let score = 0;
  if (liquidityBNB >= MIN_LIQUIDITY_BNB) score = 20;
  if (liquidityBNB >= 2 * MIN_LIQUIDITY_BNB) score = 25;
  if (liquidityBNB >= 4 * MIN_LIQUIDITY_BNB) score = 30;

  return { ok: true, score, liquidityBNB, reason: score > 0 ? "LIQ_OK" : "LIQ_LOW" };
}

/* ================= ANTI-BOT ================= */
async function checkAntiBot(pair, token) {
  const p = norm(pair);
  const t = norm(token);
  if (!p || !t) return { ok: false, score: 0, reason: "BAD_INPUT", dominance: 1, buys: 0 };

  const latest = await safe(logsQueue, () => providerLogs.getBlockNumber());
  if (latest === null) return { ok: false, score: 0, reason: "NO_LATEST_BLOCK", dominance: 1, buys: 0 };

  const fromBlock = Math.max(0, latest - ANTIBOT_LOOKBACK_BLOCKS);
  const transferTopic = ethers.id("Transfer(address,address,uint256)");

  const logs = await safe(logsQueue, () =>
    providerLogs.getLogs({
      address: t,
      topics: [transferTopic],
      fromBlock,
      toBlock: latest
    })
  );

  if (!logs || logs.length === 0) {
    return { ok: true, score: 4, reason: "NO_ACTIVITY_NEUTRAL", dominance: 1, buys: 0 };
  }

  const buyCountsByBuyer = new Map();
  let buys = 0;

  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;
    const from = norm(`0x${log.topics[1].slice(26)}`);
    const to = norm(`0x${log.topics[2].slice(26)}`);
    if (!from || !to) continue;

    if (from === p) {
      buys++;
      buyCountsByBuyer.set(to, (buyCountsByBuyer.get(to) || 0) + 1);
    }
  }

  if (buys === 0) return { ok: true, score: 4, reason: "NO_BUYS_NEUTRAL", dominance: 1, buys: 0 };

  const maxBuyerBuys = Math.max(...Array.from(buyCountsByBuyer.values()));
  const dominance = maxBuyerBuys / buys;

  let score = 0;
  if (buys < 8) score = 6;
  else {
    if (dominance < 0.25) score = 15;
    else if (dominance < 0.4) score = 12;
    else if (dominance < 0.6) score = 7;
    else score = 0;
  }

  let reason = "NO_STRONG_BOT_SIGNAL";
  if (dominance >= 0.6 && buys >= 10) reason = "BUY_DOMINANCE_HIGH";
  else if (dominance >= 0.4 && buys >= 8) reason = "BUY_DOMINANCE_MED";

  return { ok: true, score, reason, dominance, buys };
}

/* ================= BYTECODE (MAX 10) ================= */
function bytecodeStringScoreMax10(codeLower) {
  const hasMintWord = codeLower.includes("mint");
  const hasListWords = codeLower.includes("blacklist") || codeLower.includes("whitelist");
  const hasTradingToggle = codeLower.includes("enabletrading") || codeLower.includes("opentrading");
  const hasLimits = codeLower.includes("maxtx") || codeLower.includes("maxwallet") || codeLower.includes("maxhold");

  let score = 0;
  score += scoreBool(!hasMintWord, 3);
  score += scoreBool(!hasListWords, 3);
  score += scoreBool(!hasTradingToggle, 2);
  score += scoreBool(!hasLimits, 2);

  return { score: clamp(score, 0, 10), flags: { hasMintWord, hasListWords, hasTradingToggle, hasLimits } };
}

/* ================= OPCODE RISK (ONLY MINIMAL PROXY) ================= */
function opcodeRiskSignals(bytecodeHex) {
  const code = (bytecodeHex || "").toLowerCase();

  // EIP-1167 minimal proxy patterns (very common)
  const minimalProxy =
    code.includes("363d3d373d3d3d363d73") &&
    code.includes("5af43d82803e903d91602b57fd5bf3");

  return { minimalProxy };
}



/* ================= OWNERSHIP + CONCENTRATION ================= */
async function getOwner(contract) {
  const owner = await safe(readQueue, () => contract.owner());
  if (!owner) return { hasOwnerFn: false, owner: null };
  return { hasOwnerFn: true, owner: norm(owner) || owner };
}

function ownershipScore(ownerInfo) {
  if (!ownerInfo?.hasOwnerFn) return 12;
  const o = String(ownerInfo.owner || "").toLowerCase();
  if (o === ZERO || o === DEAD) return 25;
  return 0;
}

async function ownerSupplyBps(token, ownerAddr) {
  const t = norm(token);
  const o = norm(ownerAddr);
  if (!t || !o) return null;

  const tokenC = new ethers.Contract(t, [...ERC20_ABI, ...ERC20_EXTRA_ABI], providerRead);

  const [bal, ts] = await Promise.all([
    safe(readQueue, () => tokenC.balanceOf(o)),
    safe(readQueue, () => tokenC.totalSupply())
  ]);

  if (!bal || !ts) return null;

  const B = BigInt(bal);
  const S = BigInt(ts);
  if (S <= 0n) return null;

  return Number((B * 10000n) / S);
}

function ownerConcentrationScore(ownerBps) {
  if (!Number.isFinite(ownerBps)) return 0;
  if (ownerBps <= 100) return 20;
  if (ownerBps <= 300) return 15;
  if (ownerBps <= 500) return 8;
  if (ownerBps <= 1000) return 3;
  return 0;
}



// FREEZE AUTHORITY (MAX 20, BINARY)
// Rule: any freeze-style control present => 0, else 20
async function freezeAuthorityScore20(tokenAddr, bytecodeHex) {
  const t = norm(tokenAddr);
  if (!t) return { score: 0, flags: null, reason: "TOKEN_INVALID" };

  // View-only probe: if call fails or returns null, treat as not existing
  async function probeViewStrict(abiFrag, args = []) {
    try {
      const c = new ethers.Contract(t, [abiFrag], providerRead);
      const fnName = abiFrag.match(/function\s+([a-zA-Z0-9_]+)/)?.[1];
      if (!fnName) return { exists: false, value: null };

      const v = await safe(readQueue, () => c[fnName](...args));
      if (v === null) return { exists: false, value: null };
      return { exists: true, value: v };
    } catch {
      return { exists: false, value: null };
    }
  }

  // Static selector check only (no calling)
  function selectorInBytecode(codeHex, abiFrag) {
    try {
      const iface = new ethers.Interface([abiFrag]);
      const fn = iface.fragments.find((f) => f.type === "function");
      if (!fn) return false;
      const sel = iface.getFunction(fn.name).selector.slice(2).toLowerCase();
      return String(codeHex || "").toLowerCase().includes(sel);
    } catch {
      return false;
    }
  }

  const codeLower = String(bytecodeHex || "").toLowerCase();

  // View signals
  const paused = await probeViewStrict("function paused() view returns (bool)");

  const probeAddr = ZERO; // can also use DEAD
  const isBlacklisted = (await probeViewStrict("function isBlacklisted(address) view returns (bool)", [probeAddr])).exists;
  const blacklisted   = (await probeViewStrict("function blacklisted(address) view returns (bool)",   [probeAddr])).exists;
  const isFrozen      = (await probeViewStrict("function isFrozen(address) view returns (bool)",      [probeAddr])).exists;
  const frozen        = (await probeViewStrict("function frozen(address) view returns (bool)",        [probeAddr])).exists;

  // Setter signals (selector-only)
  const pauseFns =
    selectorInBytecode(bytecodeHex, "function pause()") ||
    selectorInBytecode(bytecodeHex, "function unpause()");

  const blacklistSetters =
    selectorInBytecode(bytecodeHex, "function blacklist(address,bool)") ||
    selectorInBytecode(bytecodeHex, "function setBlacklist(address,bool)") ||
    selectorInBytecode(bytecodeHex, "function setBlackList(address,bool)") ||
    selectorInBytecode(bytecodeHex, "function freeze(address,bool)") ||
    selectorInBytecode(bytecodeHex, "function setFreeze(address,bool)");

  const blacklistViews = Boolean(isBlacklisted || blacklisted || isFrozen || frozen);

  // Keyword hits are informational only, not used for scoring
  const keywordHits =
    (codeLower.includes("blacklist") ? 1 : 0) +
    (codeLower.includes("whitelist") ? 1 : 0) +
    (codeLower.includes("freeze") ? 1 : 0) +
    (codeLower.includes("unfreeze") ? 1 : 0) +
    (codeLower.includes("pause") ? 1 : 0) +
    (codeLower.includes("unpause") ? 1 : 0) +
    (codeLower.includes("paused") ? 1 : 0);

  const flags = {
    pausedFn: paused.exists,
    pausedValue: paused.exists ? Boolean(paused.value) : null,
    pauseFns,
    blacklistViews,
    blacklistSetters,
    keywordHits
  };

  // BINARY RULE: any freeze-style control => 0
  const hasFreezeRedFlag =
    flags.pausedFn ||
    flags.pauseFns ||
    flags.blacklistViews ||
    flags.blacklistSetters;

  if (hasFreezeRedFlag) {
    return { score: 0, flags, reason: "FREEZE_RED_FLAG" };
  }

  return { score: 20, flags, reason: "NO_FREEZE_CONTROLS" };
}


/* ================= MAIN FUNCTION ================= */
export async function securityPerfect(pair) {
  const p = norm(pair);

  if (!p) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_INVALID",
      pair: null,
      token: null,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  // Pair must be a contract
  let pairIsContract = false;
  try { pairIsContract = await isContract(p, providerRead); } catch {}
  if (!pairIsContract) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_NOT_CONTRACT",
      pair: p,
      token: null,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  // Resolve token from pair
  let token;
  try {
    token = norm(await resolveTokenFromPair(p, providerRead));
  } catch (e) {
    return {
      ok: false,
      pass: false,
      reason: "TOKEN_RESOLVE_FAILED",
      pair: p,
      token: null,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null,
      error: String(e?.message || e)
    };
  }

  // Token must be contract
  let tokenIsContract = false;
  try { tokenIsContract = await isContract(token, providerRead); } catch {}
  if (!tokenIsContract) {
    return {
      ok: false,
      pass: false,
      reason: "TOKEN_NOT_CONTRACT",
      pair: p,
      token,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  const contract = new ethers.Contract(token, ERC20_ABI, providerRead);

  // Basic ERC20 reads
  const basic = await Promise.all([
    safe(readQueue, () => contract.name()),
    safe(readQueue, () => contract.symbol()),
    safe(readQueue, () => contract.decimals()),
    safe(readQueue, () => contract.totalSupply())
  ]);

  if (basic.some((v) => v === null)) {
    return {
      ok: false,
      pass: false,
      reason: "ERC20_BASIC_UNREADABLE",
      pair: p,
      token,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  const [name, symbol, decimalsRaw, totalSupplyRaw] = basic;
  const decimals = Number(decimalsRaw);
  const totalSupply = BigInt(totalSupplyRaw);

  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    return {
      ok: false,
      pass: false,
      reason: "DECIMALS_INVALID",
      pair: p,
      token,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  if (totalSupply <= 0n) {
    return {
      ok: false,
      pass: false,
      reason: "TOTAL_SUPPLY_ZERO_UNSAFE",
      pair: p,
      token,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  // Bytecode fetch
  const bytecode = await safe(readQueue, () => providerRead.getCode(token));
  if (!bytecode || bytecode === "0x") {
    return {
      ok: false,
      pass: false,
      reason: "TOKEN_BYTECODE_UNREADABLE",
      pair: p,
      token,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: null
    };
  }

  /* ================= SCORING WEIGHTS (TOTAL 100) =================
     We keep your existing component functions, then normalize them into:
     - Liquidity:        max 20   (scaled from checkLiquidity max 30)
     - Freeze authority: max 20   (your freezeAuthorityScore20)
     - Ownership:        max 20   (scaled from ownershipScore max 25)
     - Concentration:    max 15   (scaled from ownerConcentrationScore max 20)
     - Anti-bot:         max 15   (checkAntiBot already max 15)
     - Bytecode words:   max 10   (bytecodeStringScoreMax10 already max 10)
     - Proxy penalty:    -15      (minimal proxy only)
  */

  // Liquidity (NO veto, score can be 0)
  const liq = await checkLiquidity(p, token);

  // Ownership + concentration (NO veto, score can be 0)
  const ownerInfo = await getOwner(contract);
  const ownScoreRaw = ownershipScore(ownerInfo); // typically 0..25

  let ownerBps = null;
  let concScoreRaw = 0; // typically 0..20
  if (ownerInfo.hasOwnerFn) {
    const o = String(ownerInfo.owner || "").toLowerCase();
    if (o && o !== ZERO && o !== DEAD) {
      ownerBps = await ownerSupplyBps(token, o);
      concScoreRaw = ownerConcentrationScore(ownerBps);
    }
  }

  // Bytecode heuristics (0..10)
  const bc = bytecodeStringScoreMax10(bytecode.toLowerCase());

  // Minimal proxy penalty (-15 or 0)
  const op = opcodeRiskSignals(bytecode);
  const proxyPenalty = op?.minimalProxy ? -15 : 0;

  // Anti-bot (0..15)
  const antibot = await checkAntiBot(p, token);

  // Freeze authority (0..20)
  const freeze = await freezeAuthorityScore20(token, bytecode);

  // Normalize/scale into your strict 100-point model
  const liqScore20 = clamp(Number(liq?.score || 0) * (20 / 30), 0, 20);
  const ownScore20 = clamp(Number(ownScoreRaw || 0) * (20 / 25), 0, 20);
  const concScore15 = clamp(Number(concScoreRaw || 0) * (15 / 20), 0, 15);

  const antibotScore15 = clamp(Number(antibot?.score || 0), 0, 15);
  const bcScore10 = clamp(Number(bc?.score || 0), 0, 10);
  const freezeScore20 = clamp(Number(freeze?.score || 0), 0, 20);

  const rawScore =
    liqScore20 +
    freezeScore20 +
    ownScore20 +
    concScore15 +
    antibotScore15 +
    bcScore10 +
    proxyPenalty;

  // Final score must stay within 0..100
  const score = clamp(rawScore, 0, 100);
  const pass = score >= MIN_SECURITY_SCORE;

  let reason = pass ? "PASS" : "SCORE_BELOW_THRESHOLD";
  if (!pass && op?.minimalProxy) reason = "SCORE_BELOW_THRESHOLD_MINIMAL_PROXY_PENALTY";

  return {
    ok: true,
    pass,
    reason,
    pair: p,
    token,
    meta: {
      name,
      symbol,
      decimals,
      totalSupply: totalSupply.toString()
    },
    score,
    minScore: MIN_SECURITY_SCORE,
    breakdown: {
      weights: {
        liquidityMax: 20,
        freezeMax: 20,
        ownershipMax: 20,
        concentrationMax: 15,
        antiBotMax: 15,
        bytecodeMax: 10,
        proxyPenalty: -15
      },
      liquidity: {
        liquidityBNB: Number(liq?.liquidityBNB || 0),
        scoreRaw: Number(liq?.score || 0),     // your original 0..30
        score: liqScore20,                    // normalized 0..20
        reason: liq?.reason || "NO_DATA"
      },
      freezeAuthority: {
        score: freezeScore20,
        flags: freeze?.flags || null,
        reason: freeze?.reason || "NO_DATA"
      },
      ownership: {
        owner: ownerInfo?.hasOwnerFn ? ownerInfo.owner : "NO_OWNER_FUNCTION",
        scoreRaw: Number(ownScoreRaw || 0),   // your original 0..25
        score: ownScore20                     // normalized 0..20
      },
      ownerConcentration: {
        ownerBps: ownerBps === null ? null : ownerBps,
        scoreRaw: Number(concScoreRaw || 0),  // your original 0..20
        score: concScore15                    // normalized 0..15
      },
      antiBot: {
        score: antibotScore15,
        reason: antibot?.reason || "NO_DATA",
        buys: Number(antibot?.buys || 0),
        dominance: Number(antibot?.dominance || 1)
      },
      bytecodeStringHeuristic: {
        score: bcScore10,
        flags: bc?.flags || null
      },
      opcodeRisk: {
        minimalProxy: Boolean(op?.minimalProxy),
        scoreImpact: proxyPenalty
      },
      scoreMath: {
        rawScore,
        clampedScore: score
      }
    }
  };
}