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

function toTriBoolFromPassObject(res) {
  // true/false: already a boolean
  if (res === true) return true;
  if (res === false) return false;

  // object: expect { pass: boolean }
  if (res && typeof res === "object") {
    if (res.pass === true) return true;
    if (res.pass === false) return false;
  }

  // unknown: missing, malformed, or partial
  return null;
}

// -------------------- STATIC --------------------
async function runStaticChecksOnce({ tokenMint, pairAddress }) {
  const startedAt = Date.now();

  const tasks = {
    securityPerfect: async () => {
      const res = await securityPerfect(pairAddress);
      return { tri: toTriBoolFromPassObject(res), raw: res };
    },
    securitySafety: async () => {
      const res = await securitySafety(pairAddress, tokenMint);
      return { tri: toTriBoolFromPassObject(res), raw: res };
    },
    liquidityLock: async () => {
      const res = await liquidityLock(tokenMint);
      return { tri: toTriBoolFromPassObject(res), raw: res };
    },
    walletRate: async () => {
      const res = await walletRate(pairAddress);
      return { tri: toTriBoolFromPassObject(res), raw: res };
    },
  };

  const settled = await Promise.allSettled(
    Object.entries(tasks).map(async ([k, fn]) => {
      try {
        const out = await fn();
        return [k, out.tri, out.raw, null];
      } catch (e) {
        return [k, null, null, e];
      }
    })
  );

  const tri = {};
  const raw = {};
  const errors = {};

  for (const item of settled) {
    if (item.status === "fulfilled") {
      const [k, triVal, rawVal, err] = item.value;
      tri[k] = triVal;
      raw[k] = rawVal;
      if (err) errors[k] = err?.message || String(err);
    } else {
      // should not happen because our wrapper returns fulfilled even on errors
      errors.unknown = item.reason?.message || String(item.reason);
    }
  }

  const unknownKeys = Object.keys(tasks).filter((k) => tri[k] === null);

  if (unknownKeys.length) {
    console.log("[processToken] STATIC WAIT: incomplete", {
      token: tokenMint,
      pair: pairAddress,
      unknownKeys,
      errors,
      ms: Date.now() - startedAt,
      raw: {
        securityPerfect: raw.securityPerfect?.pass ?? raw.securityPerfect,
        securitySafety: raw.securitySafety?.pass ?? raw.securitySafety,
        liquidityLock: raw.liquidityLock?.pass ?? raw.liquidityLock,
        walletRate: raw.walletRate?.pass ?? raw.walletRate,
      },
    });

    return { status: "wait", tri, raw, errors };
  }

  const pass = {
    secPerfectPass: tri.securityPerfect === true,
    secSafetyPass: tri.securitySafety === true,
    liqLockedPass: tri.liquidityLock === true,
    walletPass: tri.walletRate === true,
  };

  const allPass = pass.secPerfectPass && pass.secSafetyPass && pass.liqLockedPass && pass.walletPass;

  console.log("[processToken] STATIC RESULTS", {
    token: tokenMint,
    pair: pairAddress,
    securityPerfect: raw.securityPerfect?.pass ?? raw.securityPerfect,
    securitySafety: raw.securitySafety?.pass ?? raw.securitySafety,
    liquidityLock: raw.liquidityLock?.pass ?? raw.liquidityLock,
    walletRate: raw.walletRate?.pass ?? raw.walletRate,
    pass,
    ms: Date.now() - startedAt,
  });

  return { status: allPass ? "pass" : "fail", pass, tri, raw };
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
  const tokenMintRaw = String(token.tokenmint || "");
const pairAddressRaw = String(token.pairaddress || "");

const tokenMint = tokenMintRaw.toLowerCase();
const pairAddress = pairAddressRaw.toLowerCase();

const now = Date.now();

  const removeToken = (why, extra = {}) => {
    console.log("[processToken] REMOVE", {
      token: tokenMint,
      pair: pairAddress,
      why,
      ...extra,
    });
    token.remove = true;
    clearDynSlot(tokenMintRaw, pairAddressRaw);
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
  const staticRes = await runStaticChecksOnce({ tokenMint: tokenMintRaw, pairAddress: pairAddressRaw });

  if (staticRes.status === "wait") {
    // Do not remove token. Just wait for the next tick.
    return;
  }

  if (staticRes.status === "fail") {
    removeToken("STATIC_FAILED", staticRes.pass);
    return;
  }

  // PASS
  token.staticChecked = true;

  const scan = await scanedPrice(tokenMintRaw, pairAddressRaw, { full: true });
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
}

  // -------------------- COMPLEMENTARY (ONCE AFTER STATIC PASS) --------------------
  if (token.staticChecked === true && token.complimentaryChecked !== true) {
    try {
     const comp = await complimentSecurityCheck(pairAddressRaw);

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
    scan = await scanedPrice(tokenMintRaw, pairAddressRaw, { full: true });
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

  console.log("[price]", {
    token: tokenMint,
    pair: pairAddress,
    priceNow,
    entryPrice: token.entryPrice,
    rise,
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
    startActiveCheckIfIdle(pairAddressRaw, tokenMintRaw);

    return;
  }

  // -------------------- DYNAMIC SAFETY (ACTIVE) --------------------
startActiveCheckIfIdle(pairAddressRaw, tokenMintRaw);

const safetyResult = getActiveResult(tokenMintRaw, pairAddressRaw);
const safetyError = getActiveError(tokenMintRaw, pairAddressRaw);

if (!safetyResult) {
  console.log("[processToken] WAIT: no active safetyResult yet", {
    token: tokenMint,
    pair: pairAddress,
    activeRunning: isActiveRunning(tokenMintRaw, pairAddressRaw),
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

// DEBUG: confirm safety + market shape before BUY
console.log("[debug] safetyResult keys", Object.keys(safetyResult || {}));
console.log("[debug] marketPass keys", Object.keys(marketPass || {}));
console.log("[debug] lpStatus", safetyResult?.lpStatus || null);

// -------------------- BUY (NO TREND GATING) --------------------
// -------------------- BUY (NO TREND GATING) --------------------
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
if (pumpPotential < MIN_PUMP_POTENTIAL) buyBlockedReasons.push("LOW_PUMP_POTENTIAL");
if (!isMarketHealthy) buyBlockedReasons.push("MARKET_NOT_HEALTHY");
if (!isLpSafe) buyBlockedReasons.push("LP_NOT_SAFE");

const shouldBuy =
  pumpPotential >= MIN_PUMP_POTENTIAL &&
  isMarketHealthy &&
  isLpSafe;

if (shouldBuy) {
  console.log("[processToken] BUY CHECK (NO TREND)", {
    token: tokenMint,
    pair: pairAddress,
    pumpPotential,
    rise,
    marketScore: marketPass?.score,
    marketReasons: marketPass?.reasons || [],
    lpSafeRaw,
    lpSafeIsMissing,
    lpReason,
    isLpSafe,
  });

  let txHash;
  try {
    txHash = await autoBuyToken(tokenMintRaw, pairAddressRaw);
  } catch (e) {
    console.warn("[processToken] BUY FAILED:", e?.message || e);
    return;
  }

  if (!txHash) return;

  notifyBuyExecuted();

  token.bought = true;
  token.remove = true;
  clearDynSlot(tokenMintRaw, pairAddressRaw);

  console.log("[processToken] BUY CONFIRMED", {
    token: tokenMint,
    pair: pairAddress,
    txHash,
  });

  await sendTelegram(
    `BUY CONFIRMED\nToken: ${tokenMint}\nPair: ${pairAddress}\nTx: ${txHash}`
  );

} else {
  console.log("[processToken] WAIT: buy conditions not met (NO TREND)", {
    token: tokenMint,
    pair: pairAddress,
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
  });
}

// IMPORTANT: close processToken() here
} // end processToken


// ----- module-level state -----
let buyTimer = null;
let buyLoopRunning = false;

export async function buyCaller() {
  const allowed = await startCaller();
  if (!allowed) return;

  const migrators = loadMigrators();
  const tokenPromises = migrators.map((t) =>
    rpcQueue.add(() => processToken(t))
  );

  await Promise.allSettled(tokenPromises);
  saveMigrators(migrators.filter((t) => !t.remove));
}

// single guarded tick runner (prevents overlap)
async function runBuyTick(label) {
  if (buyLoopRunning) return;

  buyLoopRunning = true;
  try {
    await buyCaller();
  } catch (err) {
    console.error(`[buyCaller] ${label} error:`, err?.message || err);
  } finally {
    buyLoopRunning = false;
  }
}

export function startBuyCaller() {
  if (buyTimer) return;

  // run once immediately (non-blocking)
  void runBuyTick("initial tick");

  // then run on interval (no overlap)
  buyTimer = setInterval(() => {
    void runBuyTick("loop tick");
  }, TICK_MS);

  console.log("[buyCaller] started", { TICK_MS });
}

export async function stopBuyCaller() {
  if (!buyTimer) return;

  clearInterval(buyTimer);
  buyTimer = null;

  // wait for any running tick to finish
  while (buyLoopRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[buyCaller] stopped");
}

/* =====================================================
   OPTIONAL: allow direct execution for local testing
   Usage: node buyCaller.js
   Ignored when imported by index.js or PM2
===================================================== */
if (import.meta.url === `file://${process.argv[1]}`) {
  startBuyCaller();
}