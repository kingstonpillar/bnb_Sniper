// file: buyCaller.js (consistent working version)
// Goals:
// 1) Remove undefined/mismatched observation helpers (no startObserveIfIdle anywhere)
// 2) Align with dynamicSecurity.checkBuySafety() output shape: { safeToBuy, reasons, market, lpStatus, meta }
// 3) Keep observation timing owned by buyCaller (buy is blocked until observeUntil passes)
// 4) Keep dynamic safety orchestration non-blocking and consistent
// 5) Add logs that always reflect the real fields

import "dotenv/config";
import fs from "fs";
import fetch from "node-fetch";
import PQueue from "p-queue";

import { autoBuyToken, startCaller } from "./swapExecutor.js";
import { securityPerfect } from "./securityPerfect.js";
import { securitySafety } from "./securitycheck2.js";
import { scanedPrice } from "./scanedPrice.js";
import { liquidityLock } from "./liquidityCheck.js";
import { notifyBuyExecuted, checkBuySafety } from "./dynamicSecurity.js";
import { walletRate } from "./walletHistory.js";
import { autoTaxHoneypotCheck } from "./autoTaxHoneypotCheck.js";

const POTENTIAL_MIGRATORS = "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TICK_MS = Number(process.env.TICK_MS || 10_000);
const DELETE_MINUTES = Number(process.env.DELETE_MINUTES || 16);
const OBSERVE_MINUTES = Number(process.env.OBSERVE_MINUTES || 1);

// FAIL FAST – config validation
if (!Number.isFinite(TICK_MS) || TICK_MS <= 0) {
  throw new Error("Invalid TICK_MS env value");
}
if (!Number.isFinite(DELETE_MINUTES) || DELETE_MINUTES <= 0) {
  throw new Error("Invalid DELETE_MINUTES env value");
}
if (!Number.isFinite(OBSERVE_MINUTES) || OBSERVE_MINUTES < 0) {
  throw new Error("Invalid OBSERVE_MINUTES env value");
}


const MIN_PUMP_POTENTIAL = 40;

const rpcQueue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 5 });

/* ================= JSON ================= */
function loadMigrators() {
  if (!fs.existsSync(POTENTIAL_MIGRATORS)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(POTENTIAL_MIGRATORS, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveMigrators(data) {
  fs.writeFileSync(POTENTIAL_MIGRATORS, JSON.stringify(data, null, 2));
}

/* ================= TELEGRAM ================= */
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (err) {
    console.warn("[telegram] send failed:", err?.message || err);
  }
}

// ================= CANDLE TIMEFRAME (LIVE vs TEST) =================
const RUN_MODE = String(process.env.RUN_MODE || "live").toLowerCase();

const CANDLE_MINUTES =
  RUN_MODE === "test"
    ? Number(process.env.CANDLE_MINUTES_TEST || 1)
    : Number(process.env.CANDLE_MINUTES_LIVE || 5);

const MAX_CANDLES_KEEP = Number(process.env.MAX_CANDLES_KEEP || 50);

// Validate
if (!["live", "test"].includes(RUN_MODE)) {
  throw new Error(`Invalid RUN_MODE: ${RUN_MODE} (use "live" or "test")`);
}
if (!Number.isFinite(CANDLE_MINUTES) || CANDLE_MINUTES <= 0) {
  throw new Error("Invalid CANDLE_MINUTES_* env value");
}
if (!Number.isFinite(MAX_CANDLES_KEEP) || MAX_CANDLES_KEEP <= 0) {
  throw new Error("Invalid MAX_CANDLES_KEEP env value");
}

// Derived timeframe in ms
const CANDLE_MS = CANDLE_MINUTES * 60 * 1000;

function _bucketStartMs(ts, tfMs) {
  return Math.floor(ts / tfMs) * tfMs;
}

/**
 * Update token.candles with aggregated candles.
 * - No RPC required
 * - Uses price ticks
 * - Candle shape: { startTime, open, high, low, close }
 */
function updateCandleBuilder(token, price, ts = Date.now()) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;
  if (!token) return;

  if (!Array.isArray(token.candles)) token.candles = [];

  const bucket = _bucketStartMs(ts, CANDLE_MS);
  const candles = token.candles;
  const last = candles[candles.length - 1];

  // New candle
  if (!last || last.startTime !== bucket) {
    candles.push({
      startTime: bucket,
      open: p,
      high: p,
      low: p,
      close: p,
    });

    // Memory bound
    if (candles.length > MAX_CANDLES_KEEP) {
      candles.splice(0, candles.length - MAX_CANDLES_KEEP);
    }
    return;
  }

  // Update active candle
  last.close = p;
  if (p > last.high) last.high = p;
  if (p < last.low) last.low = p;
}

/* Optional helper */
function getCandles(token) {
  return Array.isArray(token?.candles) ? token.candles : [];
}

/* ================= TREND (CLEAN, NO DUPLICATES) ================= */

// Modes:
// - bullish_closed: last CLOSED candle is bullish
// - recovery_closed: previous CLOSED bearish, last CLOSED bullish
// - recovery_now: last CLOSED bearish, ACTIVE bullish now
// - continuation_now: last CLOSED bullish, ACTIVE bullish now
// - entry_now: recovery_now OR continuation_now
const TREND_MODE = String(process.env.TREND_MODE || "entry_now");

// Read from .env
const EPS = Number(process.env.EPS_CANDLE || 0.0005);
const CLOSED_CANDLE_OFFSET = Number(process.env.CLOSED_CANDLE_OFFSET || 2);

// Validate envs (fail fast)
if (!Number.isFinite(EPS) || EPS <= 0) throw new Error("Invalid EPS_CANDLE env value");
if (!Number.isInteger(CLOSED_CANDLE_OFFSET) || CLOSED_CANDLE_OFFSET < 1) {
  throw new Error("Invalid CLOSED_CANDLE_OFFSET env value");
}

function trendOkByMode(signals) {
  switch (TREND_MODE) {
    case "bullish_closed":
      return signals.bullishClosed;
    case "recovery_closed":
      return signals.recoveryClosed;
    case "recovery_now":
      return signals.recoveryNow;
    case "continuation_now":
      return signals.continuationNow;
    case "entry_now":
      return signals.recoveryNow || signals.continuationNow;
    default:
      throw new Error(`Invalid TREND_MODE: ${TREND_MODE}`);
  }
}

function _getOC(candle, prev) {
  if (!candle) return null;

  const close = Number(candle.close ?? candle.c);
  if (!Number.isFinite(close)) return null;

  const openRaw = candle.open ?? candle.o ?? prev?.close ?? prev?.c ?? close;
  const open = Number(openRaw);
  if (!Number.isFinite(open) || open <= 0) return null;

  return { open, close };
}

function _lastClosedIndex(candles) {
  return candles.length - CLOSED_CANDLE_OFFSET;
}

function _getLastClosed(candles) {
  const i = _lastClosedIndex(candles);
  return i >= 0 ? candles[i] : null;
}

function _getPrevClosed(candles) {
  const i = _lastClosedIndex(candles) - 1;
  return i >= 0 ? candles[i] : null;
}

function trendConfirmed(candles) {
  if (!Array.isArray(candles)) return false;

  const lastClosed = _getLastClosed(candles);
  const prevClosed = _getPrevClosed(candles);

  const oc = _getOC(lastClosed, prevClosed);
  if (!oc) return false;

  return oc.close >= oc.open * (1 + EPS);
}

function reverseDetected(candles) {
  if (!Array.isArray(candles)) return false;

  const lastClosed = _getLastClosed(candles);
  const prevClosed = _getPrevClosed(candles);

  const oc = _getOC(lastClosed, prevClosed);
  if (!oc) return false;

  return oc.close <= oc.open * (1 - EPS);
}

function recoveryConfirmed(candles) {
  if (!Array.isArray(candles)) return false;

  const lastClosed = _getLastClosed(candles);
  const prevClosed = _getPrevClosed(candles);

  // need at least 2 closed candles
  if (!lastClosed || !prevClosed) return false;

  const prev2ClosedIndex = _lastClosedIndex(candles) - 2;
  const prev2Closed = prev2ClosedIndex >= 0 ? candles[prev2ClosedIndex] : null;

  const lastOC = _getOC(lastClosed, prevClosed);
  const prevOC = _getOC(prevClosed, prev2Closed);
  if (!lastOC || !prevOC) return false;

  const lastBull = lastOC.close >= lastOC.open * (1 + EPS);
  const prevBear = prevOC.close <= prevOC.open * (1 - EPS);

  return lastBull && prevBear;
}

function isBearishCandle(candle, prev) {
  const oc = _getOC(candle, prev);
  if (!oc) return false;
  return oc.close <= oc.open * (1 - EPS);
}

function isBullishNowActive(activeCandle, lastClosed) {
  const oc = _getOC(activeCandle, lastClosed);
  if (!oc) return false;
  return oc.close >= oc.open * (1 + EPS);
}

// last CLOSED is bearish + ACTIVE bullish now
function recoveryNow(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return false;

  const active = candles[candles.length - 1];
  const lastClosed = _getLastClosed(candles);
  const prevClosed = _getPrevClosed(candles);

  if (!active || !lastClosed) return false;

  const dumpClosed = isBearishCandle(lastClosed, prevClosed);
  const activeBullNow = isBullishNowActive(active, lastClosed);

  return dumpClosed && activeBullNow;
}

// last CLOSED is bullish + ACTIVE bullish now
function continuationNow(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return false;

  const active = candles[candles.length - 1];
  const lastClosed = _getLastClosed(candles);

  if (!active || !lastClosed) return false;

  const lastClosedBull = trendConfirmed(candles);
  const activeBullNow = isBullishNowActive(active, lastClosed);

  return lastClosedBull && activeBullNow;
}

function getTrendSignals(candles) {
  const bullishClosed = trendConfirmed(candles);
  const bearishClosed = reverseDetected(candles);
  const recoveryClosed = recoveryConfirmed(candles);
  const recoveryNowSig = recoveryNow(candles);
  const continuationNowSig = continuationNow(candles);

  return {
    bullishClosed,
    bearishClosed,
    recoveryClosed,
    recoveryNow: recoveryNowSig,
    continuationNow: continuationNowSig,
  };
}
/* ================= COMPLEMENTARY ================= */
async function complimentSecurityCheck(pairAddress) {
  const res = await autoTaxHoneypotCheck(pairAddress);
  return {
    ok: Boolean(res?.safe),
    unsafeReasons: res?.unsafeReasons || [],
    flags: res?.flags || {},
    taxes: { buy: res?.buyTax || {}, sell: res?.sellTax || {} },
    token: res?.token || null,
  };
}

/* ================= DYNAMIC STATE (NON-BLOCKING) ================= */
const dyn = new Map();

function keyFor(tokenMint, pairAddress) {
  return `${String(tokenMint).toLowerCase()}|${String(pairAddress).toLowerCase()}`;
}

function ensureDynSlot(tokenMint, pairAddress) {
  const k = keyFor(tokenMint, pairAddress);
  if (!dyn.has(k)) {
    dyn.set(k, {
      activeRunning: false,
      activeResult: undefined,
      activeError: undefined,
      activeAt: 0,
    });
  }
  return k;
}

function clearDynSlot(tokenMint, pairAddress) {
  dyn.delete(keyFor(tokenMint, pairAddress));
}

/**
 * One-shot active check (NO observation here).
 * buyCaller owns observation timing (buy is blocked until observeUntil passes).
 */
function startActiveCheckIfIdle(pairAddress, tokenMint) {
  const k = ensureDynSlot(tokenMint, pairAddress);
  const slot = dyn.get(k);
  if (!slot) return;

  if (slot.activeRunning) return;

  slot.activeRunning = true;
  dyn.set(k, slot);

  console.log("[dynActive] START", {
    token: String(tokenMint).toLowerCase(),
    pair: String(pairAddress).toLowerCase(),
  });

  (async () => {
    try {
      const res = await checkBuySafety(pairAddress, tokenMint, {
  pollInterval: 3_000,
  observationMinutes: 0,
  maxWaitMinutes: 0.5,
  requiredConsecutivePasses: 1,
});

      const cur = dyn.get(k);
      if (!cur) return;

      dyn.set(k, {
        ...cur,
        activeRunning: false,
        activeResult: res,
        activeError: undefined,
        activeAt: Date.now(),
      });

      console.log("[dynActive] RESULT", {
        token: String(tokenMint).toLowerCase(),
        pair: String(pairAddress).toLowerCase(),
        safeToBuy: res?.safeToBuy,
        reasons: res?.reasons || [],
        marketHealthy: res?.market?.isHealthy,
        marketScore: res?.market?.score,
        marketReasons: res?.market?.reasons || [],
        lpSafe: res?.lpStatus?.safe,
        lpReason: res?.lpStatus?.reason,
      });
    } catch (e) {
      const cur = dyn.get(k);
      if (!cur) return;

      const errMsg = e?.message || String(e);

      dyn.set(k, {
        ...cur,
        activeRunning: false,
        activeResult: undefined,
        activeError: errMsg,
        activeAt: Date.now(),
      });

      console.log("[dynActive] ERROR", {
        token: String(tokenMint).toLowerCase(),
        pair: String(pairAddress).toLowerCase(),
        error: errMsg,
      });
    }
  })();
}

function getActiveResult(tokenMint, pairAddress) {
  const slot = dyn.get(keyFor(tokenMint, pairAddress));
  if (!slot) return null;
  return slot.activeResult || null;
}

function getActiveError(tokenMint, pairAddress) {
  const slot = dyn.get(keyFor(tokenMint, pairAddress));
  if (!slot) return null;
  return slot.activeError || null;
}

function isActiveRunning(tokenMint, pairAddress) {
  const slot = dyn.get(keyFor(tokenMint, pairAddress));
  if (!slot) return false;
  return !!slot.activeRunning;
}

/* ================= PROCESS TOKEN ================= */
async function processToken(token) {
  const tokenMint = String(token.tokenmint || "").toLowerCase();
  const pairAddress = String(token.pairaddress || "").toLowerCase();
  const now = Date.now();

  const removeToken = (why, extra = {}) => {
    console.log("[processToken] REMOVE", {
      token: tokenMint,
      pair: pairAddress,
      why,
      ...extra,
    });
    token.remove = true;
    clearDynSlot(tokenMint, pairAddress);
  };

  if (!tokenMint || !pairAddress) {
    removeToken("MISSING_TOKEN_OR_PAIR");
    return;
  }

  console.log("[processToken] TICK", {
    token: tokenMint,
    pair: pairAddress,
    hasStatic: Boolean(token.staticChecked),
    hasComplimentary: Boolean(token.complimentaryChecked),
    now,
  });

  // Expiry
  if (token.deleteTime && now >= token.deleteTime) {
    removeToken("EXPIRED", { deleteTime: token.deleteTime, now });
    return;
  }

  // -------------------- STATIC (ONCE) --------------------
  if (!token.staticChecked) {
    try {
      const [secPerfect, secSafety, liqLocked, walletRes] = await Promise.all([
        securityPerfect(pairAddress),
        securitySafety(pairAddress, tokenMint),
        liquidityLock(tokenMint),
        walletRate(pairAddress),
      ]);

      const secPerfectPass = secPerfect?.pass === true;
      const secSafetyPass = secSafety?.pass === true;
      const liqLockedPass = liqLocked?.pass === true || liqLocked === true;
      const walletPass = walletRes?.pass === true;

      console.log("[processToken] STATIC RESULTS", {
        token: tokenMint,
        pair: pairAddress,
        securityPerfect: secPerfect?.pass,
        securitySafety: secSafety?.pass,
        liquidityLock: liqLocked?.pass ?? liqLocked,
        walletRate: walletRes?.pass,
        pass: { secPerfectPass, secSafetyPass, liqLockedPass, walletPass },
      });

      token.staticChecked = secPerfectPass && secSafetyPass && liqLockedPass && walletPass;

      if (!token.staticChecked) {
        removeToken("STATIC_FAILED", { secPerfectPass, secSafetyPass, liqLockedPass, walletPass });
        return;
      }

      const scan = await scanedPrice(tokenMint, pairAddress, { full: true });
      const entryPx = Number(scan?.priceBNB);

      console.log("[processToken] ENTRY SCAN", {
        token: tokenMint,
        pair: pairAddress,
        priceBNB: scan?.priceBNB,
        reservesWBNB: scan?.reserves?.wbnb,
        marketCapBNB: scan?.marketCapBNB,
        liquidityBNB: scan?.liquidityBNB,
      });

      if (!Number.isFinite(entryPx) || entryPx <= 0) {
        removeToken("BAD_ENTRY_PRICE", { entryPx });
        return;
      }

      token.entryPrice = entryPx;
      token.entryTime = now;
      token.deleteTime = now + DELETE_MINUTES * 60 * 1000;
      token.observeUntil = now + OBSERVE_MINUTES * 60 * 1000;

      // Initialize candle series and seed the first 5m candle with entry price
token.candles = [];
updateCandleBuilder(token, entryPx, now);

      const entryReserve = Number(scan?.reserves?.wbnb);
      token.lastBNBReserve = Number.isFinite(entryReserve) ? entryReserve : null;

      token.complimentaryChecked = false;
      token.complimentaryOk = false;

      console.log("[processToken] STATIC PASS -> OBSERVE SET", {
        token: tokenMint,
        observeUntil: token.observeUntil,
        observeSeconds: Math.max(0, Math.floor((token.observeUntil - Date.now()) / 1000)),
      });

      return;
    } catch (e) {
      removeToken("STATIC_ERROR", { err: e?.message || String(e) });
      return;
    }
  }

  // -------------------- COMPLEMENTARY (ONCE AFTER STATIC PASS) --------------------
  if (token.staticChecked === true && token.complimentaryChecked !== true) {
    try {
      const comp = await complimentSecurityCheck(pairAddress);

      console.log("[processToken] COMPLEMENTARY", {
        token: tokenMint,
        pair: pairAddress,
        ok: Boolean(comp.ok),
        reasons: comp.unsafeReasons || [],
      });

      token.complimentaryChecked = true;
      token.complimentaryOk = Boolean(comp.ok);
      token.complimentaryReasons = comp.unsafeReasons;

      if (!token.complimentaryOk) {
        await sendTelegram(
          `REMOVED (Complementary fail)\nToken: ${tokenMint}\nPair: ${pairAddress}\nReasons: ${(comp.unsafeReasons || []).join(", ")}`
        );
        removeToken("COMPLEMENTARY_FAILED", { reasons: comp.unsafeReasons || [] });
        return;
      }

      // No startObserveIfIdle here. Observation is handled only by observeUntil + process loop.
      return;
    } catch (e) {
      removeToken("COMPLEMENTARY_ERROR", { err: e?.message || String(e) });
      return;
    }
  }

  // -------------------- PRICE UPDATES ALWAYS --------------------
  let scan;
  try {
    scan = await scanedPrice(tokenMint, pairAddress, { full: true });
  } catch (e) {
    removeToken("SCAN_ERROR", { err: e?.message || String(e) });
    return;
  }

  const priceNow = Number(scan?.priceBNB);
  if (!Number.isFinite(priceNow) || priceNow <= 0) {
    removeToken("BAD_PRICE_NOW", { priceNow });
    return;
  }
  if (!Number.isFinite(token.entryPrice) || token.entryPrice <= 0) {
    removeToken("MISSING_ENTRY_PRICE", { entryPrice: token.entryPrice });
    return;
  }

  const rise = (priceNow - token.entryPrice) / token.entryPrice;

// Candles (aggregated by CANDLE_MINUTES for test/live)
updateCandleBuilder(token, priceNow, Date.now());

const candles = token.candles || [];
const signals = getTrendSignals(candles);
const trendOk = trendOkByMode(signals);

console.log("[trend]", {
  mode: TREND_MODE,
  closedOffset: CLOSED_CANDLE_OFFSET,
  bullishClosed: signals.bullishClosed,
  bearishClosed: signals.bearishClosed,
  recoveryClosed: signals.recoveryClosed,
  recoveryNow: signals.recoveryNow,
  continuationNow: signals.continuationNow,
  lastClosed: candles[candles.length - CLOSED_CANDLE_OFFSET] || null,
  active: candles[candles.length - 1] || null,
});


  // Reserve tracking
  const prevReserve = Number(token.lastBNBReserve);
  const reserveNow = Number(scan?.reserves?.wbnb);
  if (Number.isFinite(reserveNow)) token.lastBNBReserve = reserveNow;

  // -------------------- OBSERVE MODE (NO BUY) --------------------
  // Observation is only enforced here. We may still warm dynamic checks, but we do not buy.
  if (token.observeUntil && Date.now() < token.observeUntil) {
    const remainingMs = token.observeUntil - Date.now();

    console.log("[processToken] OBSERVATION MODE", {
      token: tokenMint,
      pair: pairAddress,
      remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
    });

    // Optional: warm active safety cache during observation (still non-blocking)
    startActiveCheckIfIdle(pairAddress, tokenMint);

    return;
  }

  // -------------------- DYNAMIC SAFETY (ACTIVE) --------------------
startActiveCheckIfIdle(pairAddress, tokenMint);

const safetyResult = getActiveResult(tokenMint, pairAddress);
const safetyError = getActiveError(tokenMint, pairAddress);

if (!safetyResult) {
  console.log("[processToken] WAIT: no active safetyResult yet", {
    token: tokenMint,
    pair: pairAddress,
    activeRunning: isActiveRunning(tokenMint, pairAddress),
    activeError: safetyError || null,
  });
  return;
}

if (safetyResult?.safeToBuy !== true) {
  console.log("[processToken] WAIT: safeToBuy false", {
    token: tokenMint,
    pair: pairAddress,
    safeToBuy: safetyResult?.safeToBuy,
    reasons: safetyResult?.reasons || [],
    marketHealthy: safetyResult?.market?.isHealthy,
    marketScore: safetyResult?.market?.score,
    marketReasons: safetyResult?.market?.reasons || [],
    lpSafe: safetyResult?.lpStatus?.safe,
    lpReason: safetyResult?.lpStatus?.reason,
    activeError: safetyError || null,
  });
  return;
}

const marketPass = safetyResult?.market || null;
if (!marketPass?.isHealthy) {
  console.log("[processToken] WAIT: market not healthy", {
    token: tokenMint,
    pair: pairAddress,
    marketHealthy: marketPass?.isHealthy,
    marketScore: marketPass?.score,
    marketReasons: marketPass?.reasons || [],
  });
  return;
}


  // -------------------- STRATEGY FILTERS (WAIT, DO NOT DELETE) --------------------
const dt = (Date.now() - token.entryTime) / 1000;
const velocityTooHigh = dt > 0 && rise / dt > 0.003;

const mcap = Number(scan?.marketCapBNB);
const liq = Number(scan?.liquidityBNB);
const mcapLiquidityBad =
  Number.isFinite(mcap) && Number.isFinite(liq) && liq > 0 && mcap / liq > 25;

const fakeFlowDetected =
  Number.isFinite(prevReserve) &&
  prevReserve > 0 &&
  Number.isFinite(reserveNow) &&
  rise > 0.15 &&
  (reserveNow - prevReserve) / prevReserve < 0.03;

if (velocityTooHigh || mcapLiquidityBad || fakeFlowDetected) {
  console.log("[processToken] WAIT: strategy filters", {
    token: tokenMint,
    pair: pairAddress,
    velocityTooHigh,
    mcapLiquidityBad,
    fakeFlowDetected,
    rise,
    dt,
    mcap,
    liq,
    prevReserve,
    reserveNow,
  });
  return;
}

// -------------------- BUY --------------------
const pumpPotential = marketPass?.pumpPotential ?? marketPass?.score ?? 0;

// Market
const isMarketHealthy = marketPass?.isHealthy === true;

// LP safety
const lpSafeRaw = safetyResult?.lpStatus?.safe;   // true | false | undefined | null
const lpReason = safetyResult?.lpStatus?.reason;  // e.g. "STABLE"
const lpSafeIsMissing = lpSafeRaw == null;

const isLpSafe =
  lpSafeRaw === true ||
  (lpSafeIsMissing && lpReason === "STABLE");

// Diagnostics
const buyBlockedReasons = [];
if (!trendOk) buyBlockedReasons.push(`TREND_MODE_BLOCK:${TREND_MODE}`);
if (pumpPotential < MIN_PUMP_POTENTIAL) buyBlockedReasons.push("LOW_PUMP_POTENTIAL");
if (!isMarketHealthy) buyBlockedReasons.push("MARKET_NOT_HEALTHY");
if (!isLpSafe) buyBlockedReasons.push("LP_NOT_SAFE");

const shouldBuy =
  trendOk &&
  pumpPotential >= MIN_PUMP_POTENTIAL &&
  isMarketHealthy &&
  isLpSafe;

if (shouldBuy) {
  console.log("[processToken] BUY CHECK", {
    token: tokenMint,
    pair: pairAddress,

    trendMode: TREND_MODE,
    trendOk,
    signals,

    pumpPotential,
    rise,

    marketScore: marketPass?.score,
    marketReasons: marketPass?.reasons || [],

    lpSafeRaw,
    lpSafeIsMissing,
    lpReason,
    isLpSafe,

    lastClosed: candles[candles.length - CLOSED_CANDLE_OFFSET] || null,
    active: candles[candles.length - 1] || null,
  });

  let txHash;
  try {
    txHash = await autoBuyToken(tokenMint, pairAddress);
  } catch (e) {
    console.warn("[processToken] BUY FAILED:", e?.message || e);
    return;
  }

  if (!txHash) return;

  notifyBuyExecuted();

  token.bought = true;
  token.remove = true;
  clearDynSlot(tokenMint, pairAddress);

  console.log("[processToken] BUY CONFIRMED", {
    token: tokenMint,
    pair: pairAddress,
    txHash,
  });

  await sendTelegram(
    `BUY CONFIRMED\nToken: ${tokenMint}\nPair: ${pairAddress}\nTx: ${txHash}`
  );
} else {
  console.log("[processToken] WAIT: buy conditions not met", {
    token: tokenMint,
    pair: pairAddress,

    trendMode: TREND_MODE,
    trendOk,
    signals,

    pumpPotential,
    minPumpPotential: MIN_PUMP_POTENTIAL,
    rise,

    marketHealthy: isMarketHealthy,

    lpSafeRaw,
    lpSafeIsMissing,
    lpReason,
    isLpSafe,

    marketScore: marketPass?.score,
    marketReasons: marketPass?.reasons || [],

    buyBlockedReasons,

    lastClosed: candles[candles.length - CLOSED_CANDLE_OFFSET] || null,
    active: candles[candles.length - 1] || null,
  });
}

// IMPORTANT: close processToken() here
} // end processToken

/* ================= BUY CALLER ================= */
export async function buyCaller() {
  const allowed = await startCaller();
  if (!allowed) return;

  const migrators = loadMigrators();
  const tokenPromises = migrators.map((t) => rpcQueue.add(() => processToken(t)));

  await Promise.allSettled(tokenPromises);
  saveMigrators(migrators.filter((t) => !t.remove));
}

/* ================= INTERVAL ================= */
setInterval(async () => {
  try {
    await buyCaller();
  } catch (err) {
    console.error("[buyCaller] error:", err?.message || err);
  }
}, TICK_MS);