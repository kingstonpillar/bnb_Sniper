// file: buyCaller.js (full version)
// Fixes: scanedPrice() compatibility (object mode), reserve field names, marketCap field names
// Assumes: scanedPrice(tokenMint, pairAddress, { full: true }) returns object as in your scanedPrice.js
// Notes:
// - No strategy changes beyond making scan usage consistent and safe.
// - Keeps your dynamic safety orchestration intact.

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
const OBSERVE_MINUTES = 5;

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

function clearMigrators() {
  saveMigrators([]);
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
    console.warn("Telegram send failed:", err?.message || err);
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
      observeRunning: false,
      observeDone: false,
      activeRunning: false,
      activeAt: 0,
    });
  }
  return k;
}

function clearDynSlot(tokenMint, pairAddress) {
  dyn.delete(keyFor(tokenMint, pairAddress));
}

function startObserveIfIdle(pairAddress, tokenMint) {
  const k = ensureDynSlot(tokenMint, pairAddress);
  const slot = dyn.get(k);
  if (!slot) return;

  if (slot.observeRunning || slot.observeDone) return;

  slot.observeRunning = true;
  dyn.set(k, slot);

  (async () => {
    try {
      const res = await checkBuySafety(pairAddress, tokenMint, {
        pollInterval: TICK_MS,
        observationMinutes: OBSERVE_MINUTES,
        maxWaitMinutes: OBSERVE_MINUTES,
      });

      const cur = dyn.get(k);
      if (!cur) return;

      dyn.set(k, {
        ...cur,
        observeRunning: false,
        observeDone: true,
        observeResult: res,
        observeError: undefined,
      });
    } catch (e) {
      const cur = dyn.get(k);
      if (!cur) return;

      dyn.set(k, {
        ...cur,
        observeRunning: false,
        observeDone: true,
        observeResult: undefined,
        observeError: e?.message || String(e),
      });
    }
  })();
}

function startActiveCheckIfIdle(pairAddress, tokenMint) {
  const k = ensureDynSlot(tokenMint, pairAddress);
  const slot = dyn.get(k);
  if (!slot) return;

  if (slot.activeRunning) return;

  slot.activeRunning = true;
  dyn.set(k, slot);

  (async () => {
    try {
      const res = await checkBuySafety(pairAddress, tokenMint, {
        pollInterval: TICK_MS,
        observationMinutes: 0,
        maxWaitMinutes: 0.2,
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
    } catch (e) {
      const cur = dyn.get(k);
      if (!cur) return;

      dyn.set(k, {
        ...cur,
        activeRunning: false,
        activeResult: undefined,
        activeError: e?.message || String(e),
        activeAt: Date.now(),
      });
    }
  })();
}

function getActiveResult(tokenMint, pairAddress) {
  const slot = dyn.get(keyFor(tokenMint, pairAddress));
  if (!slot) return null;
  return slot.activeResult || null;
}

/* ================= PROCESS TOKEN ================= */
async function processToken(token) {
  const tokenMint = String(token.tokenmint || "").toLowerCase();
  const pairAddress = String(token.pairaddress || "").toLowerCase();
  const now = Date.now();

  const removeToken = () => {
    token.remove = true;
    clearDynSlot(tokenMint, pairAddress);
  };

  if (!tokenMint || !pairAddress) {
    removeToken();
    return;
  }

  // Expiry
  if (token.deleteTime && now >= token.deleteTime) {
    removeToken();
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
    const secSafetyPass  = secSafety?.pass === true;
    const liqLockedPass  = liqLocked?.pass === true || liqLocked === true;
    const walletPass    = walletRes?.pass === true;

    token.staticChecked =
      secPerfectPass &&
      secSafetyPass &&
      liqLockedPass &&
      walletPass;

    if (!token.staticChecked) {
      removeToken();
      return;
    }

    const scan = await scanedPrice(tokenMint, pairAddress, { full: true });
    const entryPx = Number(scan?.priceBNB);

    if (!Number.isFinite(entryPx) || entryPx <= 0) {
      removeToken();
      return;
    }

    token.entryPrice = entryPx;
    token.entryTime = now;
    token.deleteTime = now + DELETE_MINUTES * 60 * 1000;
    token.observeUntil = now + OBSERVE_MINUTES * 60 * 1000;

    token.candles = [{
      open: entryPx,
      close: entryPx,
      high: entryPx,
      low: entryPx,
      startTime: now,
    }];

    const entryReserve = Number(scan?.reserves?.wbnb);
    token.lastBNBReserve = Number.isFinite(entryReserve) ? entryReserve : null;

    token.complimentaryChecked = false;
    token.complimentaryOk = false;

    return;

  } catch (e) {
    token.staticChecked = false;
    removeToken();
    return;
  }
}

  // -------------------- COMPLEMENTARY (ONCE AFTER STATIC PASS) --------------------
  if (token.staticChecked === true && token.complimentaryChecked !== true) {
    try {
      const comp = await complimentSecurityCheck(pairAddress);

      token.complimentaryChecked = true;
      token.complimentaryOk = Boolean(comp.ok);
      token.complimentaryReasons = comp.unsafeReasons;

      if (!token.complimentaryOk) {
        await sendTelegram(
          `REMOVED (Complementary fail)\nToken: ${tokenMint}\nPair: ${pairAddress}\nReasons: ${(comp.unsafeReasons || []).join(", ")}`
        );
        removeToken();
        return;
      }

      // Start observe phase in background
      startObserveIfIdle(pairAddress, tokenMint);
      return;
    } catch (e) {
      removeToken();
      return;
    }
  }

  // -------------------- PRICE UPDATES ALWAYS --------------------
  const scan = await scanedPrice(tokenMint, pairAddress, { full: true });
  const priceNow = Number(scan?.priceBNB);

  if (!Number.isFinite(priceNow) || priceNow <= 0) {
    removeToken();
    return;
  }
  if (!Number.isFinite(token.entryPrice) || token.entryPrice <= 0) {
    removeToken();
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

  // Reserve tracking: use scan.reserves.wbnb
  const prevReserve = Number(token.lastBNBReserve);
  const reserveNow = Number(scan?.reserves?.wbnb);

  if (Number.isFinite(reserveNow)) {
    token.lastBNBReserve = reserveNow;
  }

  // -------------------- OBSERVE MODE (NO BUY) --------------------
  if (token.observeUntil && Date.now() < token.observeUntil) {
    startObserveIfIdle(pairAddress, tokenMint);
    return;
  }

  // Refresh dynamic safety frequently
  startActiveCheckIfIdle(pairAddress, tokenMint);

  const safetyResult = getActiveResult(tokenMint, pairAddress);
  if (!safetyResult) return;

  // In active mode: safeToBuy false is NOT deletion, just wait
  if (safetyResult?.safeToBuy !== true) return;

  const marketPass = safetyResult?.marketBehavior || safetyResult?.marketHealth || null;
  if (!marketPass?.isHealthy) return;

  // Strategy filters (do NOT delete, just wait)
  const dt = (Date.now() - token.entryTime) / 1000;
  const velocityTooHigh = dt > 0 && rise / dt > 0.003;

  // marketCap field is marketCapBNB (NOT marketCap)
  const mcap = Number(scan?.marketCapBNB);
  const liq = Number(scan?.liquidityBNB);
  const mcapLiquidityBad =
    Number.isFinite(mcap) && Number.isFinite(liq) && liq > 0 && mcap / liq > 25;

  // Fake flow: use reserves.wbnb (NOT scan.bnbReserve)
  const fakeFlowDetected =
    Number.isFinite(prevReserve) &&
    prevReserve > 0 &&
    Number.isFinite(reserveNow) &&
    rise > 0.15 &&
    (reserveNow - prevReserve) / prevReserve < 0.03;

  if (velocityTooHigh || mcapLiquidityBad || fakeFlowDetected) return;

  if (reverseDetected(candles, rise)) {
    token.trendPersistence = 0;
    return;
  }

  updateTrendPersistence(token, candles);
  const REQUIRED_PERSISTENCE = 2;

  const pumpPotential = marketPass?.pumpPotential ?? marketPass?.score ?? 0;

  // -------------------- BUY --------------------
  if (token.trendPersistence >= REQUIRED_PERSISTENCE && pumpPotential >= 50) {
    let txHash;

    try {
      txHash = await autoBuyToken(tokenMint, pairAddress);
    } catch (e) {
      console.warn("BUY FAILED:", e?.message || e);
      return;
    }

    if (!txHash) {
      // could be max entries reached (swapExecutor may stopCaller())
      return;
    }

    // successful buy
    notifyBuyExecuted();
    token.bought = true;
    token.remove = true;
    clearDynSlot(tokenMint, pairAddress);

    await sendTelegram(`BUY CONFIRMED\nToken: ${tokenMint}\nTx: ${txHash}`);
  }
}

/* ================= BUY CALLER ================= */
export async function buyCaller() {
  const allowed = await startCaller();
  if (!allowed) return;

  const migrators = loadMigrators();

  const tokenPromises = migrators.map((token) =>
    rpcQueue.add(() => processToken(token))
  );

  await Promise.allSettled(tokenPromises);

  saveMigrators(migrators.filter((t) => !t.remove));
}

/* ================= INTERVAL ================= */
setInterval(async () => {
  try {
    await buyCaller();
  } catch (err) {
    console.error("buyCaller error:", err?.message || err);
  }
}, TICK_MS);
