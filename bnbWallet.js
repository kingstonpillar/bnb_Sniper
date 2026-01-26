// bnbWallet.js
// Purpose:
// - Computes new tradePerEntry ONLY after a completed multi-sell phase (allSellsComplete === true)
// - Heartbeat is BALANCE ONLY (no compute in heartbeat)
// - Daily summary resets daily state and clears pnl_history.json for next day
// - Writes trade amount to trade_config.json atomically
// - PM2-friendly start/stop loops via startWalletLoops/stopWalletLoops

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { allSellsComplete } from "./sellmonitor.js";

dotenv.config();

/* ================= FILES ================= */

const TRADE_FILE = "./trade_config.json";
const PNL_FILE = "./pnl_history.json";

/* ================= JSON ATOMIC WRITE ================= */
function safeWriteJSON(path, obj) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
}

function safeReadJSON(path) {
  try {
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* ================= CHECKSUM HELPERS ================= */
function toChecksum(addr) {
  return ethers.getAddress(String(addr || "").trim());
}

/* ================= RPC CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_8, process.env.RPC_URL_9].filter(Boolean);
if (!RPC_URLS.length) throw new Error("At least one RPC_URL_* required");

// limiter: 6 req/sec
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });

let activeRpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

async function withRpcFailover(fn) {
  let lastError;

  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      lastError = err;
      console.warn(`RPC failed (${RPC_URLS[activeRpcIndex]}): ${err?.message || err}`);

      activeRpcIndex = (activeRpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

      console.log(`Switching RPC to: ${RPC_URLS[activeRpcIndex]}`);
    }
  }

  throw new Error(`All RPCs failed: ${lastError?.message || "unknown error"}`);
}

/* ================= BOT CONFIG ================= */
let WALLET_ADDRESS;
try {
  WALLET_ADDRESS = toChecksum(process.env.WALLET_ADDRESS);
} catch {
  throw new Error("WALLET_ADDRESS is missing or invalid");
}

const buyGas = parseFloat(process.env.BUY_GAS_FEE || "0.001");
const sellGas = parseFloat(process.env.SELL_GAS_FEE || "0.001");
const backupAmount = parseFloat(process.env.BACKUP_BNB || "0.001");
const maxEntries = parseInt(process.env.MAX_ENTRIES || "5", 10);

const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

/* ================= STATE ================= */
export let currentTradeAmount = 0;

let lastTradeAmount = null;
let previousDayBalance = null;

let dailyTradeStats = {
  buys: 0,
  sells: 0,
  totalBuyVolume: 0,
  totalSellVolume: 0,
  feesPaid: 0,
};

/* ================= TELEGRAM ================= */
async function sendTelegram(msg) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "Markdown" }),
    });
  } catch {}
}

/* ================= FILE RESET ================= */
function resetTradeConfig() {
  // Intentionally clears for the next compounding round
  safeWriteJSON(TRADE_FILE, {});
}

function resetDailyPnL() {
  // Intentionally resets for the next day
  safeWriteJSON(PNL_FILE, { lastBalance: 0 });
}

/* ================= TRADE RECORD ================= */
export function recordTrade(type, amount, fee = 0) {
  if (type === "buy") {
    dailyTradeStats.buys++;
    dailyTradeStats.totalBuyVolume += amount;
  } else if (type === "sell") {
    dailyTradeStats.sells++;
    dailyTradeStats.totalSellVolume += amount;
  }
  dailyTradeStats.feesPaid += fee;
}

/* ================= WALLET BALANCE ================= */
export async function getWalletBalance() {
  try {
    const balance = await withRpcFailover((p) => p.getBalance(WALLET_ADDRESS));
    return Number(ethers.formatEther(balance));
  } catch (err) {
    console.error("Balance fetch failed:", err?.message || err);
    return 0;
  }
}

/* ================= DAILY SUMMARY ================= */
async function sendDailySummary() {
  const bal = await getWalletBalance();

  if (previousDayBalance === null) {
    previousDayBalance = bal;
    return;
  }

  const pnl = bal - previousDayBalance;
  const emoji = pnl >= 0 ? "🟢" : "🔴";

  await sendTelegram(
    `📊 *Daily Bot Summary*\n\n` +
      `💰 Start: ${previousDayBalance.toFixed(6)} BNB\n` +
      `💰 Now:   ${bal.toFixed(6)} BNB\n` +
      `${emoji} PnL: ${pnl.toFixed(6)} BNB`
  );

  previousDayBalance = bal;
  dailyTradeStats = { buys: 0, sells: 0, totalBuyVolume: 0, totalSellVolume: 0, feesPaid: 0 };

  // Clean JSON for another day PnL
  resetDailyPnL();
}

/* ================= COMPUTE TRADE AMOUNT ================= */
export async function computeTradeAmount() {
  const sold = await allSellsComplete();
  if (!sold) {
    console.log("[computeTradeAmount] Not all sells are complete.");
    return;
  }

  // Empty for new trade amount to write in
  resetTradeConfig();

  const bal = await getWalletBalance();
  if (bal <= 0) {
    console.log("[computeTradeAmount] Wallet balance is zero or negative.");
    return;
  }

  const totalGas = maxEntries * (buyGas + sellGas);
  const totalReserve = totalGas + backupAmount;
  const tradePerEntry = (bal - totalReserve) / maxEntries;

  if (!Number.isFinite(tradePerEntry) || tradePerEntry <= 0) {
    console.log("[computeTradeAmount] Invalid trade per entry amount.");
    return;
  }

  const changed = lastTradeAmount === null || Math.abs(tradePerEntry - lastTradeAmount) > 1e-12;

  if (changed) {
    lastTradeAmount = tradePerEntry;
    currentTradeAmount = tradePerEntry;

    console.log(`Trade computed: ${tradePerEntry.toFixed(6)} BNB`);

    // Debug logging before writing to file
    console.log("Writing to trade_config.json:", {
      balanceBefore: bal,
      totalGas,
      buyGas,
      sellGas,
      backupAmount,
      totalReserve,
      maxEntries,
      tradePerEntry,
    });

    // Writing to JSON
    try {
      safeWriteJSON(TRADE_FILE, {
        balanceBefore: bal,
        totalGas,
        buyGas,
        sellGas,
        backupAmount,
        totalReserve,
        maxEntries,
        tradePerEntry,
        timestamp: Date.now(),
      });
      console.log("[computeTradeAmount] Trade amount written to trade_config.json");
    } catch (err) {
      console.error("[computeTradeAmount] Error writing to trade_config.json:", err);
    }

    // Sending Telegram alert
    try {
      await sendTelegram(
        ` *New Trade Round*\n` +
        `Trade/Entry: ${tradePerEntry.toFixed(6)} BNB\n` +
        `Balance: ${bal.toFixed(6)} BNB\n` +
        `Reserve: ${totalReserve.toFixed(6)} BNB\n` +
        `Entries: ${maxEntries}`
      );
      console.log("[computeTradeAmount] Telegram alert sent.");
    } catch (err) {
      console.error("[computeTradeAmount] Error sending Telegram alert:", err);
    }
  } else {
    console.log("[computeTradeAmount] No change in trade amount.");
  }
}

/* ================= HEARTBEAT (BALANCE ONLY) ================= */
export async function sendBalanceHeartbeat() {
  const bal = await getWalletBalance();
  if (!Number.isFinite(bal)) return;

  await sendTelegram(
    `💓 *bnb_Sniper Heartbeat*\n` +
      `Wallet: ${WALLET_ADDRESS}\n` +
      `Balance: ${bal.toFixed(6)} BNB\n` +
      `Time: ${new Date().toISOString()}`
  );
}

// ================= LOOPS (PM2 FRIENDLY) =================
let hbTimer = null;
let dailyTimer = null;
let computeTimer = null;

let hbRunning = false;
let dailyRunning = false;
let computeRunning = false;

async function runGuarded(label, flagName, fn) {
  if (flagName === "hb") {
    if (hbRunning) return;
    hbRunning = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[wallet] ${label} error:`, err?.message || err);
    } finally {
      hbRunning = false;
    }
    return;
  }

  if (flagName === "daily") {
    if (dailyRunning) return;
    dailyRunning = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[wallet] ${label} error:`, err?.message || err);
    } finally {
      dailyRunning = false;
    }
    return;
  }

  if (flagName === "compute") {
    if (computeRunning) return;
    computeRunning = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[wallet] ${label} error:`, err?.message || err);
    } finally {
      computeRunning = false;
    }
  }
}

export function startWalletLoops({
  heartbeatMs = 60 * 60 * 1000, // hourly
  dailyMs = 24 * 60 * 60 * 1000, // daily
  computeMs = 30 * 1000, // fast watcher for allSellsComplete
} = {}) {
  if (!hbTimer) {
    void runGuarded("heartbeat initial tick", "hb", sendBalanceHeartbeat);
    hbTimer = setInterval(() => void runGuarded("heartbeat tick", "hb", sendBalanceHeartbeat), heartbeatMs);
    console.log("[wallet] heartbeat started", { heartbeatMs });
  }

  if (!dailyTimer) {
    dailyTimer = setInterval(() => void runGuarded("daily summary tick", "daily", sendDailySummary), dailyMs);
    console.log("[wallet] daily summary started", { dailyMs });
  }

  if (!computeTimer) {
    computeTimer = setInterval(() => void runGuarded("computeTradeAmount tick", "compute", computeTradeAmount), computeMs);
    console.log("[wallet] computeTradeAmount watcher started", { computeMs });
  }
}

// Ensure start when running directly via `node`
if (import.meta.url === `file://${process.argv[1]}`) {
  startWalletLoops();
}

export async function stopWalletLoops() {
  if (hbTimer) clearInterval(hbTimer);
  if (dailyTimer) clearInterval(dailyTimer);
  if (computeTimer) clearInterval(computeTimer);

  hbTimer = null;
  dailyTimer = null;
  computeTimer = null;

  // wait for any running tick to finish
  while (hbRunning || dailyRunning || computeRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[wallet] loops stopped");
}