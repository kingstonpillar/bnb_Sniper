// file: securityPerfect.js
// Purpose: fast, capital-free, read-only security scoring for a Pancake v2 WBNB pair.
// Notes:
// - No eth_call swaps. No simulator. Pure RPC reads + logs heuristics.
// - Uses two providers: READ (calls) and LOGS (getLogs).
// - Fixes multiple correctness issues in your current version:
//   1) Transfer log decoding: topics[1]/topics[2] hold from/to, NOT log.data
//   2) Volume uses token decimals, not hardcoded 18
//   3) getReserves destructuring was wrong
//   4) Anti-bot sender counting logic was wrong (was decoding log.data as addresses)
//   5) Safer handling of missing RPCs, missing pair/token, out-of-range block windows
// - Keeps your spirit: bytecode string heuristics + buyers/volume + liquidity + anti-bot
// - Does NOT add LP lock/burn checks, as you said you will do other security later.

import fs from "fs";
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
const POTENTIAL_MIGRATORS = "./potential_migrators.json";
const WBNB_ADDRESS = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase();
const DEAD = "0x000000000000000000000000000000000000dead";
const MIN_SECURITY_SCORE = Number(process.env.MIN_SECURITY_SCORE || 50);

// Buyer window
const BUYER_LOOKBACK_BLOCKS = Number(process.env.BUYER_LOOKBACK_BLOCKS || 15_000);
// Anti-bot recent activity window
const ANTIBOT_LOOKBACK_BLOCKS = Number(process.env.ANTIBOT_LOOKBACK_BLOCKS || 2_000);

// Liquidity threshold in BNB
const MIN_LIQUIDITY_BNB = Number(process.env.MIN_LIQUIDITY_BNB || 20);

// Buyer thresholds
const MIN_UNIQUE_BUYERS = Number(process.env.MIN_UNIQUE_BUYERS || 15);
const MIN_VOLUME_TOKENS = Number(process.env.MIN_VOLUME_TOKENS || 0); // if you want, set >0

/* ================= ABIs ================= */
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)"
];

const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];

/* ================= HELPERS ================= */
function scoreBool(cond, val) {
  return cond ? val : 0;
}

function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
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

/* ================= BUYER STATS (Transfer logs heuristic) ================= */
async function getBuyStats(pair, token, tokenDecimals) {
  const p = norm(pair);
  const t = norm(token);
  if (!p || !t) return null;

  const latest = await safe(logsQueue, () => providerLogs.getBlockNumber());
  if (!latest) return null;

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
    // ERC20 Transfer indexed: topics[1]=from, topics[2]=to, data=value
    if (!log.topics || log.topics.length < 3) continue;

    const from = norm(`0x${log.topics[1].slice(26)}`);
    const to = norm(`0x${log.topics[2].slice(26)}`);

    // Value is uint256 in data
    let value = 0n;
    try {
      value = BigInt(log.data);
    } catch {
      value = 0n;
    }

    // Buy heuristic: from == pair means token is being sent out of pair to buyer
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

  return {
    uniqueBuyers: buyers.size,
    totalVolumeTokens: volumeFormatted
  };
}

/* ================= LIQUIDITY CHECK (BNB reserve) ================= */
async function checkLiquidity(pair, token) {
  const p = norm(pair);
  const t = norm(token);
  if (!p || !t) return { score: 0, liquidityBNB: 0, reason: "BAD_INPUT" };

  const pairContract = new ethers.Contract(p, PAIR_ABI, providerRead);

  const reserves = await safe(readQueue, () => pairContract.getReserves());
  if (!reserves) return { score: 0, liquidityBNB: 0, reason: "RESERVES_UNREADABLE" };

  // ethers v6 returns an array-like result: [reserve0, reserve1, timestamp]
  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);

  const token0 = norm(await safe(readQueue, () => pairContract.token0()));
  const token1 = norm(await safe(readQueue, () => pairContract.token1()));
  if (!token0 || !token1) return { score: 0, liquidityBNB: 0, reason: "PAIR_TOKENS_UNREADABLE" };

  // We want the WBNB side reserve
  let wbnbReserve = 0n;
  if (token0 === WBNB_ADDRESS) wbnbReserve = reserve0;
  else if (token1 === WBNB_ADDRESS) wbnbReserve = reserve1;
  else return { score: 0, liquidityBNB: 0, reason: "PAIR_NOT_WBNB" };

  const liquidityBNB = Number(ethers.formatUnits(wbnbReserve, 18));
  const score = liquidityBNB >= MIN_LIQUIDITY_BNB ? 10 : 0;

  return { score, liquidityBNB, reason: score ? "LIQ_OK" : "LIQ_LOW" };
}

/* ================= ANTI-BOT HEURISTIC ================= */
async function checkAntiBot(pair, token) {
  const p = norm(pair);
  const t = norm(token);
  if (!p || !t) return { score: 0, reason: "BAD_INPUT" };

  const latest = await safe(logsQueue, () => providerLogs.getBlockNumber());
  if (!latest) return { score: 0, reason: "NO_LATEST_BLOCK" };

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

  // No logs means very new token or low activity, treat as neutral, not safe
  if (!logs || logs.length === 0) return { score: 2, reason: "NO_ACTIVITY_NEUTRAL" };

  // Heuristic:
  // - count how many buys (pair -> to) happen and whether 1 address dominates
  // - count how many times the pair is sender overall (buy bursts)
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

  if (buys === 0) return { score: 2, reason: "NO_BUYS_NEUTRAL" };

  const maxBuyerBuys = Math.max(...Array.from(buyCountsByBuyer.values()));
  const dominance = maxBuyerBuys / buys;

  // If one buyer is doing the majority of buys in a short window, that can be bot or sniper cluster
  // We penalize dominance, but mildly because this is not proof.
  if (dominance >= 0.6 && buys >= 10) return { score: 0, reason: "BUY_DOMINANCE_HIGH" };
  if (dominance >= 0.4 && buys >= 8) return { score: 2, reason: "BUY_DOMINANCE_MED" };

  return { score: 5, reason: "NO_STRONG_BOT_SIGNAL" };
}

/* ================= BYTECODE STRING HEURISTICS ================= */
function bytecodeStringScore(codeLower) {
  // IMPORTANT: strings are weak, many bytecodes do not contain readable strings.
  // This remains a signal only. We keep your scoring weights but make it safer.

  let score = 0;

  // Conservative checks. If strings are absent, these may all pass. Treat as weak signal.
  const hasMintWord = codeLower.includes("mint");
  const hasListWords = codeLower.includes("blacklist") || codeLower.includes("whitelist");
  const hasTradingToggle = codeLower.includes("enabletrading") || codeLower.includes("opentrading");
  const hasLimits = codeLower.includes("maxtx") || codeLower.includes("maxwallet") || codeLower.includes("maxhold");

  score += scoreBool(!hasMintWord, 25);
  score += scoreBool(!hasListWords, 20);
  score += scoreBool(!hasTradingToggle, 10);
  score += scoreBool(!hasLimits, 15);

  return { score, flags: { hasMintWord, hasListWords, hasTradingToggle, hasLimits } };
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

  // Optional allowlist gate
  const tokens = readJSON(POTENTIAL_MIGRATORS);
  const listed = Array.isArray(tokens)
    ? tokens.find((t) => norm(t?.pairaddress) === p)
    : null;

  if (!listed) {
    return {
      ok: false,
      pass: false,
      reason: "PAIR_NOT_IN_POTENTIAL_MIGRATORS",
      pair: p,
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

  /* ================= SCORING ================= */

  let score = 0;

  // Ownership
  let ownerAddress = "UNKNOWN";
  let ownerScore = 0;
  const owner = await safe(readQueue, () => contract.owner());

  if (owner) {
    ownerAddress = norm(owner) || owner;
    ownerScore =
      ownerAddress === ethers.ZeroAddress.toLowerCase() || ownerAddress === DEAD
        ? 20
        : 0;
  } else {
    ownerScore = 10;
    ownerAddress = "NO_OWNER_FUNCTION";
  }
  score += ownerScore;

  // Bytecode heuristic
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

  const bc = bytecodeStringScore(bytecode.toLowerCase());
  score += bc.score;

  // Buy stats
  const stats = await getBuyStats(p, token, decimals);
  let buyersScore = 0;
  let volumeScore = 0;

  if (stats) {
    buyersScore = scoreBool(stats.uniqueBuyers >= MIN_UNIQUE_BUYERS, 5);
    volumeScore = MIN_VOLUME_TOKENS > 0
      ? scoreBool(stats.totalVolumeTokens >= MIN_VOLUME_TOKENS, 5)
      : 0;
    score += buyersScore + volumeScore;
  }

  // Liquidity
  const liq = await checkLiquidity(p, token);
  score += liq.score;

  // Anti-bot
  const antibot = await checkAntiBot(p, token);
  score += antibot.score;

  const pass = score >= MIN_SECURITY_SCORE;

  return {
    ok: true,
    pass,
    reason: pass ? "PASS" : "SCORE_BELOW_THRESHOLD",
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
      ownership: { owner: ownerAddress, score: ownerScore },
      bytecodeStringHeuristic: { score: bc.score, flags: bc.flags },
      buyers: stats
        ? {
            uniqueBuyers: stats.uniqueBuyers,
            totalVolumeTokens: stats.totalVolumeTokens,
            score: buyersScore + volumeScore
          }
        : { score: 0, reason: "NO_STATS" },
      liquidity: {
        liquidityBNB: liq.liquidityBNB,
        score: liq.score,
        reason: liq.reason
      },
      antiBot: {
        score: antibot.score,
        reason: antibot.reason
      }
    }
  };
}