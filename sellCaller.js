// file: sellCaller.js
import fs from "fs";
import PQueue from "p-queue";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

import { scanedPrice } from "./scanedPrice.js";
import { executeAutoSell } from "./autoSellToken.js";
import { getTokenLiquidity } from "./liquidityCheck.js";

const ACTIVE_POSITIONS_FILE = "./active_positions.json";

// ---------------- CONFIG ----------------
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 10000);
const PRICE_DROP_TRIGGER = 0.70;
const PROFIT_TAKE_MULTIPLIER = 2;
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PANIC_DROP_THRESHOLD = 0.4;
const PANIC_DROP_WINDOW_MS = 10_000;

const FAST_DROP_THRESHOLD = 0.3;
const FAST_DROP_WINDOW_MS = 60_000;

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ---------------- STATE ----------------
const lastLiquidity = new Map();
const liquidityHistory = new Map();
const sellQueue = new PQueue({ concurrency: 6 });

// ---------------- HELPERS ----------------
function toChecksum(addr) {
  try {
    return ethers.getAddress(String(addr || "").trim());
  } catch {
    return "";
  }
}

async function telegramAlert(msg) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("Telegram error:", err?.message || err);
  }
}

// Read-only parse with retry, avoids blowing up during atomic rename windows
function readPositions() {
  const exists = fs.existsSync(ACTIVE_POSITIONS_FILE);

  console.log("[readPositions] path:", ACTIVE_POSITIONS_FILE, "exists:", exists);

  if (!exists) return [];

  for (let i = 0; i < 3; i++) {
    try {
      const raw = fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8");

      console.log("[readPositions] bytes:", raw.length);

      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      console.log(
        "[readPositions] JSON parse failed (attempt",
        i + 1,
        "):",
        e?.message || e
      );

      // tiny backoff to avoid rename/write race
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }

  console.log("[readPositions] failed after 3 attempts, returning empty array");
  return [];
}
async function isLiquidityDropTooFast(tokenMint, currentLiquidity) {
  const now = Date.now();
  const history = liquidityHistory.get(tokenMint);

  if (!history) {
    liquidityHistory.set(tokenMint, { lastLiquidity: currentLiquidity, timestamp: now });
    return false;
  }

  const drop = (history.lastLiquidity - currentLiquidity) / history.lastLiquidity;
  const deltaTime = now - history.timestamp;

  liquidityHistory.set(tokenMint, { lastLiquidity: currentLiquidity, timestamp: now });

  return drop >= FAST_DROP_THRESHOLD && deltaTime <= FAST_DROP_WINDOW_MS;
}

// ---------------- CHECK SINGLE POSITION ----------------
async function checkPosition(pos) {
  // Accept both key styles
  const rawToken = pos?.tokenMint ?? pos?.tokenmint ?? "";
  const rawPair  = pos?.pairAddress ?? pos?.pairaddress ?? "";

  console.log("[checkPosition] RAW INPUT", {
    rawToken,
    rawPair,
    buyPrice: pos?.buyPrice,
    timestamp: pos?.timestamp
  });

  const tokenMint = toChecksum(rawToken);
  const pairAddress = toChecksum(rawPair);

  console.log("[checkPosition] NORMALIZED", {
    tokenMint,
    pairAddress
  });

  const buyPrice = Number(pos?.buyPrice || 0);
  const symbol = String(pos?.symbol || tokenMint || "UNKNOWN");

  // Entry time: allow "timestamp" as ISO string or number (ms)
  const entryRaw = pos?.timestamp ?? pos?.entryTime ?? pos?.entry_time;
  const entryMs =
    typeof entryRaw === "number"
      ? entryRaw
      : entryRaw
      ? new Date(entryRaw).getTime()
      : 0;

  const now = Date.now();
  const elapsedMs = entryMs ? now - entryMs : 0;
  const elapsedHours = entryMs ? elapsedMs / 3600000 : 0;

  console.log("[checkPosition] START", {
    symbol,
    rawToken,
    tokenMint,
    rawPair,
    pairAddress,
    buyPrice,
    entryRaw,
    entryIso: entryMs ? new Date(entryMs).toISOString() : null,
    elapsedHours: entryMs ? Number(elapsedHours.toFixed(2)) : null,
  });

  // Must have a valid token address
  if (!tokenMint) {
    console.log("[checkPosition] SKIP: invalid tokenMint");
    return;
  }

  // -------------------
  // 24H TIME EXIT FIRST
  // -------------------
  const TOKEN_MAX_AGE_MS_LOCAL = 24 * 60 * 60 * 1000; // 24h

  if (entryMs && elapsedMs >= TOKEN_MAX_AGE_MS_LOCAL) {
    console.log("[checkPosition] TIME EXIT TRIGGERED", {
      tokenMint,
      elapsedHours: Number(elapsedHours.toFixed(2)),
    });

    await telegramAlert(
      `🚨 SELL SIGNAL\nToken: ${symbol}\nReason: Trade age >24h\nEntry: ${new Date(entryMs).toISOString()}`
    );

    await sellQueue.add(() => executeAutoSell(tokenMint));
    console.log("[checkPosition] SELL QUEUED (TIME EXIT)", tokenMint);
    return;
  }

  // If you are only testing time exits, you can stop here if buyPrice is missing
  if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
    console.log("[checkPosition] SKIP: buyPrice missing/invalid (no price-based logic will run)");
    return;
  }

  // -------------------
  // Price + liquidity logic
  // -------------------
  let currentPrice = buyPrice;
  let action = null;
  let reason = "";

  try {
    console.log("[checkPosition] fetching price/liquidity", tokenMint);

    const priceNow = await scanedPrice(tokenMint);
    if (Number.isFinite(priceNow)) currentPrice = priceNow;

    const liquidity = await getTokenLiquidity(tokenMint);
    const prevLiquidity = lastLiquidity.get(tokenMint) ?? liquidity;

    console.log("[checkPosition] market snapshot", {
      tokenMint,
      buyPrice,
      currentPrice,
      liquidity,
      prevLiquidity,
    });

    if (currentPrice < buyPrice * PRICE_DROP_TRIGGER) {
      action = "SELL_FULL";
      reason = "Price rug detected";
    }

    if (!action && currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER) {
      action = "SELL_FULL";
      reason = "Profit target reached";
    }

    if (!action && prevLiquidity > 0) {
      const drop = (prevLiquidity - liquidity) / prevLiquidity;
      const prevTs = lastLiquidity.get(tokenMint + "_ts") ?? now;
      if (drop >= PANIC_DROP_THRESHOLD && now - prevTs <= PANIC_DROP_WINDOW_MS) {
        action = "SELL_FULL";
        reason = `Liquidity dropped ${Math.round(drop * 100)}% in ${PANIC_DROP_WINDOW_MS / 1000}s`;
      }
    }

    if (!action && liquidity > 0) {
      if (await isLiquidityDropTooFast(tokenMint, liquidity)) {
        action = "SELL_FULL";
        reason = "Fast liquidity drop ≥30% within 1 min";
      }
    }

    lastLiquidity.set(tokenMint, liquidity);
    lastLiquidity.set(tokenMint + "_ts", now);

    console.log("[checkPosition] DECISION", { tokenMint, action, reason });

    if (!action) return;

    await telegramAlert(
      `🚨 SELL SIGNAL\nToken: ${symbol}\nReason: ${reason}\nPrice: ${currentPrice.toFixed(6)} BNB`
    );

    await sellQueue.add(() => executeAutoSell(tokenMint));
    console.log("[checkPosition] SELL QUEUED", tokenMint);

  } catch (err) {
    console.error(`Error processing ${symbol} (${tokenMint}):`, err?.message || err);
    await telegramAlert(`❌ Sell failed ${symbol}\n${err?.message || err}`);
  }
}

// ---------------- MONITOR LOOP ----------------
export async function sellCaller() {
  const positions = readPositions();
  console.log("[sellCaller] tick | positions:", positions.length);

  if (!positions.length) return;

  for (const pos of positions) {
    await checkPosition(pos);
  }
}

let sellTimer = null;

export function startSellCaller() {
  if (sellTimer) return;
  sellTimer = setInterval(async () => {
    try {
      await sellCaller();
    } catch (err) {
      console.error("[sellCaller] loop error:", err?.message || err);
    }
  }, Number(process.env.SELL_TICK_MS || 10_000)); // keep ms inside module, not index
  console.log("[sellCaller] started");
}

export function stopSellCaller() {
  if (!sellTimer) return;
  clearInterval(sellTimer);
  sellTimer = null;
  console.log("[sellCaller] stopped");
}

// ----- module-level state -----
let sellTimer = null;
let sellLoopRunning = false;

// single guarded tick runner (prevents overlap)
async function runSellTick(label) {
  if (sellLoopRunning) return;

  sellLoopRunning = true;
  try {
    await sellCaller();
  } catch (err) {
    console.error(`[sellCaller] ${label} error:`, err?.message || err);
  } finally {
    sellLoopRunning = false;
  }
}

// start looping sellCaller
export function startSellCaller() {
  if (sellTimer) return;

  // run once immediately
  void runSellTick("initial tick");

  // then loop at interval
  sellTimer = setInterval(() => {
    void runSellTick("loop tick");
  }, CHECK_INTERVAL_MS);

  console.log("[sellCaller] started", { CHECK_INTERVAL_MS });
}

// stop looping sellCaller safely
export async function stopSellCaller() {
  if (sellTimer) {
    clearInterval(sellTimer);
    sellTimer = null;
  }

  // wait for any active loop to finish
  while (sellLoopRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[sellCaller] stopped");
}