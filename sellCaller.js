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
const TOKEN_MAX_AGE_MS = 16 * 60 * 60 * 1000;

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
  if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return [];
  for (let i = 0; i < 3; i++) {
    try {
      const raw = fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8");
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      // tiny backoff
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
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
  const tokenMint = toChecksum(pos?.tokenMint);
  const buyPrice = Number(pos?.buyPrice || 0);
  const symbol = String(pos?.symbol || tokenMint || "UNKNOWN");
  const timestamp = pos?.timestamp;

  if (!tokenMint || !Number.isFinite(buyPrice) || buyPrice <= 0) return;

  let currentPrice = buyPrice;
  let action = null;
  let reason = "";

  try {
    const priceNow = await scanedPrice(tokenMint);
if (Number.isFinite(priceNow)) currentPrice = priceNow;

    const liquidity = await getTokenLiquidity(tokenMint);
    const prevLiquidity = lastLiquidity.get(tokenMint) ?? liquidity;
    const now = Date.now();

    if (currentPrice < buyPrice * PRICE_DROP_TRIGGER) {
      action = "SELL_FULL";
      reason = "Price rug detected";
    }

    if (!action && currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER) {
      action = "SELL_FULL";
      reason = "Profit target reached";
    }

    if (!action && timestamp) {
      const ageMs = now - new Date(timestamp).getTime();
      if (Number.isFinite(ageMs) && ageMs > TOKEN_MAX_AGE_MS) {
        action = "SELL_FULL";
        reason = "Trade age >16h";
      }
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

    if (!action) return;

    await telegramAlert(`🚨 SELL SIGNAL\nToken: ${symbol}\nReason: ${reason}\nPrice: ${currentPrice.toFixed(6)} BNB`);

    // sellmonitor is notified inside executeAutoSell only
    await sellQueue.add(() => executeAutoSell(tokenMint));

  } catch (err) {
    console.error(`Error processing ${symbol} (${tokenMint}):`, err?.message || err);
    await telegramAlert(`❌ Sell failed ${symbol}\n${err?.message || err}`);
  }
}

// ---------------- MONITOR LOOP ----------------
export async function sellCaller() {
  const positions = readPositions();
  if (!positions.length) return;

  for (const pos of positions) {
    await checkPosition(pos);
  }
}

// ---------------- RUN INTERVAL ----------------
setInterval(() => {
  sellCaller().catch(err => console.error("SellCaller loop error:", err?.message || err));
}, CHECK_INTERVAL_MS);

console.log(`sellCaller running every ${CHECK_INTERVAL_MS}ms`);