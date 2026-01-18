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

// Buyer window
const BUYER_LOOKBACK_BLOCKS = Number(process.env.BUYER_LOOKBACK_BLOCKS || 15_000);
// Anti-bot recent activity window
const ANTIBOT_LOOKBACK_BLOCKS = Number(process.env.ANTIBOT_LOOKBACK_BLOCKS || 2_000);

// Liquidity threshold in BNB
const MIN_LIQUIDITY_BNB = Number(process.env.MIN_LIQUIDITY_BNB || 24);

// Buyer thresholds
const MIN_UNIQUE_BUYERS = Number(process.env.MIN_UNIQUE_BUYERS || 15);
const MIN_VOLUME_TOKENS = Number(process.env.MIN_VOLUME_TOKENS || 0);

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

/* ================= BUYER STATS ================= */
async function getBuyStats(pair, token, tokenDecimals) {
  const p = norm(pair);
  const t = norm(token);
  if (!p || !t) return null;

  const latest = await safe(logsQueue, () => providerLogs.getBlockNumber());
  if (latest === null) return null;

  const fromBlock = Math.max(0, latest - BUYER_LOOKBACK_BLOCKS);
  const transferTopic = ethers.id("Transfer(address,address,uint256)");

  const logs = await safe(logsQueue, () =>
    providerLogs.getLogs({
      address: t,
      topics: [transferTopic],
      fromBlock,
      toBlock: latest
    })
  );

  if (!logs) return null;

  const buyers = new Set();
  let tokenVolume = 0n;

  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;

    const from = norm(`0x${log.topics[1].slice(26)}`);
    const to = norm(`0x${log.topics[2].slice(26)}`);

    let value = 0n;
    try {
      value = BigInt(log.data);
    } catch {
      value = 0n;
    }

    if (from && from === p && to) {
      buyers.add(to);
      tokenVolume += value;
    }
  }

  let volumeFormatted = 0;
  try {
    volumeFormatted = Number(ethers.formatUnits(tokenVolume, tokenDecimals));
  } catch {
    volumeFormatted = 0;
  }

  return { uniqueBuyers: buyers.size, totalVolumeTokens: volumeFormatted };
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

// Score mark only, no veto
function minimalProxyScore(op) {
  // You said: do not veto. Just score mark.
  // If minimalProxy: penalize score (implementation/upgrade risk), but still allow passing if other signals are strong.
  if (op?.minimalProxy) return -15;
  return 0;
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

function buyersVolumeScore(stats) {
  if (!stats) return { score: 0, buyersScore: 0, volumeScore: 0 };

  const buyers = Number(stats.uniqueBuyers || 0);
  const vol = Number(stats.totalVolumeTokens || 0);

  let buyersScore = 0;
  if (buyers >= MIN_UNIQUE_BUYERS) buyersScore = 10;
  if (buyers >= MIN_UNIQUE_BUYERS * 2) buyersScore = 12;
  if (buyers >= MIN_UNIQUE_BUYERS * 3) buyersScore = 15;

  let volumeScore = 0;
  if (MIN_VOLUME_TOKENS > 0) {
    if (vol >= MIN_VOLUME_TOKENS) volumeScore = 5;
  }

  return { score: clamp(buyersScore + volumeScore, 0, 20), buyersScore, volumeScore };
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
  try {
    pairIsContract = await isContract(p, providerRead);
  } catch {}

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
  try {
    tokenIsContract = await isContract(token, providerRead);
  } catch {}

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

  // Bytecode fetch (used for strings + minimal proxy mark)
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

  // Liquidity (keep veto low liquidity)
  const liq = await checkLiquidity(p, token);
  if (liq.ok && liq.liquidityBNB < MIN_LIQUIDITY_BNB) {
    return {
      ok: true,
      pass: false,
      reason: "VETO_LOW_LIQUIDITY",
      pair: p,
      token,
      score: 0,
      minScore: MIN_SECURITY_SCORE,
      breakdown: { liquidity: liq }
    };
  }

  // Ownership
  const ownerInfo = await getOwner(contract);
  const ownScore = ownershipScore(ownerInfo);

  let ownerBps = null;
  let concScore = 0;

  // Keep veto: owner holds too much supply
  if (ownerInfo.hasOwnerFn) {
    const o = String(ownerInfo.owner || "").toLowerCase();
    if (o && o !== ZERO && o !== DEAD) {
      ownerBps = await ownerSupplyBps(token, o);
      concScore = ownerConcentrationScore(ownerBps);

      if (Number.isFinite(ownerBps) && ownerBps > 1000) {
        return {
          ok: true,
          pass: false,
          reason: "VETO_OWNER_SUPPLY_TOO_HIGH",
          pair: p,
          token,
          score: 0,
          minScore: MIN_SECURITY_SCORE,
          breakdown: {
            ownership: { owner: ownerInfo.owner, score: ownScore },
            ownerConcentration: { ownerBps, score: concScore }
          }
        };
      }
    }
  }

  // Bytecode heuristics
  const bc = bytecodeStringScoreMax10(bytecode.toLowerCase());

  // Minimal proxy mark (score only, no veto)
  const op = opcodeRiskSignals(bytecode);
  const proxyPenalty = minimalProxyScore(op);

  // Buyer stats and antibot
  const stats = await getBuyStats(p, token, decimals);
  const buyersVol = buyersVolumeScore(stats);
  const antibot = await checkAntiBot(p, token);

  // Total score
  const rawScore =
    (liq.ok ? liq.score : 0) +
    ownScore +
    concScore +
    buyersVol.score +
    (antibot.ok ? antibot.score : 0) +
    bc.score +
    proxyPenalty;

  // Clamp to never go below 0
  const score = clamp(rawScore, 0, 999);

  const pass = score >= MIN_SECURITY_SCORE;

  // Reason
  let reason = "SCORE_BELOW_THRESHOLD";
  if (pass) reason = "PASS";
  else if (op.minimalProxy && rawScore < MIN_SECURITY_SCORE) reason = "SCORE_BELOW_THRESHOLD_MINIMAL_PROXY_PENALTY";

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
      liquidity: {
        liquidityBNB: liq.liquidityBNB,
        score: liq.score,
        reason: liq.reason
      },
      ownership: {
        owner: ownerInfo.hasOwnerFn ? ownerInfo.owner : "NO_OWNER_FUNCTION",
        score: ownScore
      },
      ownerConcentration: {
        ownerBps: ownerBps === null ? null : ownerBps,
        score: concScore
      },
      bytecodeStringHeuristic: {
        score: bc.score,
        flags: bc.flags
      },
      buyers: stats
        ? {
            uniqueBuyers: stats.uniqueBuyers,
            totalVolumeTokens: stats.totalVolumeTokens,
            score: buyersVol.score,
            buyersScore: buyersVol.buyersScore,
            volumeScore: buyersVol.volumeScore
          }
        : { score: 0, reason: "NO_STATS" },
      antiBot: {
        score: antibot.score,
        reason: antibot.reason,
        buys: antibot.buys,
        dominance: antibot.dominance
      },
      opcodeRisk: {
        minimalProxy: Boolean(op.minimalProxy),
        scoreImpact: proxyPenalty
      },
      scoreMath: {
        rawScore,
        clampedScore: score
      }
    }
  };
}
