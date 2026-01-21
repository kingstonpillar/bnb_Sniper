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

const TICK_MS = 10_000;
const DELETE_MINUTES = 16;
const OBSERVE_MINUTES = 1; // buyCaller-only observation window

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

/* ================= TREND ================= */
function trendConfirmed(candles, rise) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return rise >= 0.1 && last.high > prev.high && last.low > prev.low;
}

function reverseDetected(candles, rise) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  if (rise > 0.12 && last.low < prev.low) return true;

  if (
    candles.length >= 3 &&
    last.high < prev.high &&
    prev.high < candles[candles.length - 3].high
  ) {
    return true;
  }
  return false;
}

function updateTrendPersistence(token, candles) {
  if (!token.trendPersistence) token.trendPersistence = 0;

  const rise =
    (candles[candles.length - 1].close - token.entryPrice) / token.entryPrice;

  if (trendConfirmed(candles, rise)) token.trendPersistence += 1;
  else token.trendPersistence = 0;
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
        pollInterval: TICK_MS,
        observationMinutes: 0,
        maxWaitMinutes: 0.2,
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
        lpSafe: res?.lpStatus?.safeToBuy,
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

      token.candles = [
        {
          open: entryPx,
          close: entryPx,
          high: entryPx,
          low: entryPx,
          startTime: now,
        },
      ];

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

  // Candles update every tick
  const candles = token.candles || [];
  const prevClose = candles.length ? candles[candles.length - 1].close : priceNow;

  candles.push({
    open: prevClose,
    close: priceNow,
    high: Math.max(priceNow, prevClose),
    low: Math.min(priceNow, prevClose),
    startTime: Date.now(),
  });

  if (candles.length > 3) candles.shift();
  token.candles = candles;

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
      lpSafe: safetyResult?.lpStatus?.safeToBuy,
      lpReason: safetyResult?.lpStatus?.reason,
    });
    return;
  }

  const marketPass = safetyResult?.market || null;
  if (!marketPass?.isHealthy) {
    console.log("[processToken] WAIT: market not healthy", {
      token: tokenMint,
      pair: pairAddress,
      market: marketPass,
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

  if (reverseDetected(candles, rise)) {
    console.log("[processToken] WAIT: reverse detected", {
      token: tokenMint,
      pair: pairAddress,
      rise,
      candles,
    });
    token.trendPersistence = 0;
    return;
  }

  updateTrendPersistence(token, candles);
  const REQUIRED_PERSISTENCE = 2;

  const pumpPotential = marketPass?.pumpPotential ?? marketPass?.score ?? 0;

  // -------------------- BUY --------------------
  if (token.trendPersistence >= REQUIRED_PERSISTENCE && pumpPotential >= 50) {
    console.log("[processToken] BUY CHECK", {
      token: tokenMint,
      pair: pairAddress,
      trendPersistence: token.trendPersistence,
      requiredPersistence: REQUIRED_PERSISTENCE,
      pumpPotential,
      rise,
      marketScore: marketPass?.score,
      marketReasons: marketPass?.reasons || [],
      lpReason: safetyResult?.lpStatus?.reason,
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

    await sendTelegram(`BUY CONFIRMED\nToken: ${tokenMint}\nPair: ${pairAddress}\nTx: ${txHash}`);
  } else {
    console.log("[processToken] WAIT: buy conditions not met", {
      token: tokenMint,
      pair: pairAddress,
      trendPersistence: token.trendPersistence || 0,
      requiredPersistence: REQUIRED_PERSISTENCE,
      pumpPotential,
      rise,
    });
  }
}

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
