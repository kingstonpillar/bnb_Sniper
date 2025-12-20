// file: sellCaller.js
import fs from "fs";
import PQueue from "p-queue";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

import { scanedPrice } from "./scanedPrice.js";
import { executeAutoSell } from "./autosellToken.js";
import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";
import { getTokenLiquidity } from "./liquidityCheck.js";

const ACTIVE_POSITIONS_FILE = "./active_positions.json";

// ---------------- CONFIG ----------------
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 10000); // 10s
const PRICE_DROP_TRIGGER = 0.70; // 30% drop triggers sell
const PROFIT_TAKE_MULTIPLIER = 2; // 2x entry price profit
const TOKEN_MAX_AGE_MS = 16 * 60 * 60 * 1000; // 16 hours

// Panic liquidity drop
const PANIC_DROP_THRESHOLD = 0.4; // 40% drop in normal window
const PANIC_DROP_WINDOW_MS = 10_000; // 10s

// Fast liquidity drop
const FAST_DROP_THRESHOLD = 0.3; // 30% drop
const FAST_DROP_WINDOW_MS = 60_000; // 1 min

// Telegram
const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ---------------- STATE ----------------
const lastLiquidity = new Map();
const liquidityHistory = new Map(); // tokenMint → { lastLiquidity, timestamp }
const sellQueue = new PQueue({ concurrency: 6 });

// ---------------- TELEGRAM ALERT ----------------
async function telegramAlert(msg) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("Telegram error:", err.message || err);
  }
}

// ---------------- READ / WRITE ACTIVE POSITIONS ----------------
function readPositions() {
  if (!fs.existsSync(ACTIVE_POSITIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writePositions(positions) {
  fs.writeFileSync(ACTIVE_POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// ---------------- LIQUIDITY DROP HELPERS ----------------
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
  const { tokenMint, buyPrice, amount, symbol, timestamp } = pos;

  let currentPrice = buyPrice;
  let action = null;
  let reason = "";

  try {
    const priceNow = await scanedPrice(tokenMint);
    if (priceNow != null) currentPrice = priceNow;

    const liquidity = await getTokenLiquidity(tokenMint);
    const prevLiquidity = lastLiquidity.get(tokenMint) || liquidity;
    const now = Date.now();

    // --- Price drop trigger ---
    if (currentPrice < buyPrice * PRICE_DROP_TRIGGER) {
      action = "SELL_FULL";
      reason = "Price rug detected";
    }

    // --- Profit take ---
    if (!action && currentPrice >= buyPrice * PROFIT_TAKE_MULTIPLIER) {
      action = "SELL_FULL";
      reason = "Profit target reached";
    }

    // --- Token age ---
    if (!action && timestamp) {
      const ageMs = now - new Date(timestamp).getTime();
      if (ageMs > TOKEN_MAX_AGE_MS) {
        action = "SELL_FULL";
        reason = "Trade age >16h";
      }
    }

    // --- Slow liquidity drop ---
    if (!action && prevLiquidity > 0) {
      const drop = (prevLiquidity - liquidity) / prevLiquidity;
      if (drop >= PANIC_DROP_THRESHOLD && now - (lastLiquidity.get(tokenMint + "_ts") || now) <= PANIC_DROP_WINDOW_MS) {
        action = "SELL_FULL";
        reason = `Liquidity dropped ${Math.round(drop*100)}% in ${PANIC_DROP_WINDOW_MS/1000}s`;
      }
    }

    // --- Fast liquidity drop ---
    if (!action && liquidity > 0) {
      if (await isLiquidityDropTooFast(tokenMint, liquidity)) {
        action = "SELL_FULL";
        reason = `Fast liquidity drop ≥30% within 1 min`;
      }
    }

    lastLiquidity.set(tokenMint, liquidity);
    lastLiquidity.set(tokenMint + "_ts", now);

    if (!action) return; // nothing to do

    // --- EXECUTE SELL ---
    await markSellStart(tokenMint);
    await telegramAlert(`🚨 SELL SIGNAL\nToken: ${symbol}\nReason: ${reason}\nPrice: ${currentPrice.toFixed(6)} BNB`);

    await sellQueue.add(() => executeAutoSell(tokenMint, amount));

    await markSellComplete(tokenMint);
    await telegramAlert(`✔ Sell completed\nToken: ${symbol}\nPrice: ${currentPrice.toFixed(6)} BNB`);

  } catch (err) {
    console.error(`Error processing ${symbol} (${tokenMint}):`, err.message || err);
    await telegramAlert(`❌ Sell failed ${symbol}\n${err.message || err}`);
  }
}

// ---------------- MONITOR LOOP ----------------
export async function sellCaller() {
  const positions = readPositions();
  if (!positions.length) return;

  for (const pos of positions) {
    await checkPosition(pos);
  }

  if (await allSellsComplete()) console.log("🟢 All sells complete for monitored tokens.");
}

// ---------------- RUN INTERVAL ----------------
setInterval(() => {
  sellCaller().catch(err => console.error("SellCaller loop error:", err.message || err));
}, CHECK_INTERVAL_MS);

console.log(`🤖 sellCaller running every ${CHECK_INTERVAL_MS}ms`);