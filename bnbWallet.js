// file: walletBalance.js — BNB version
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { allSellsComplete } from "./sellmonitor.js";

dotenv.config();

// ================= RPC CONFIG =================
const RPC_URLS = [
  process.env.RPC_URL_8,
  process.env.RPC_URL_9
].filter(Boolean);

if (!RPC_URLS.length) {
  throw new Error("❌ At least one RPC_URL_* required");
}

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
      console.warn(`⚠️ RPC failed (${RPC_URLS[activeRpcIndex]}): ${err.message}`);
      lastError = err;

      activeRpcIndex = (activeRpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

      console.log(`➡️ Switching RPC to: ${RPC_URLS[activeRpcIndex]}`);
    }
  }

  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

// ================= BOT CONFIG =================
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

const buyGas = parseFloat(process.env.BUY_GAS_FEE || "0.001");
const sellGas = parseFloat(process.env.SELL_GAS_FEE || "0.001");
const backupAmount = parseFloat(process.env.BACKUP_BNB || "0.001");
const maxEntries = parseInt(process.env.MAX_ENTRIES || "5");

const TRADE_FILE = "./trade_config.json";
const PNL_FILE = "./pnl_history.json";

const TG_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ================= STATE =================
export let currentTradeAmount = 0;
let lastTradeAmount = null;
let lastBalance = null;
let previousDayBalance = null;

let dailyTradeStats = {
  buys: 0,
  sells: 0,
  totalBuyVolume: 0,
  totalSellVolume: 0,
  feesPaid: 0
};

// ================= TELEGRAM =================
async function sendTelegram(msg) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "Markdown" })
    });
  } catch {}
}

// ================= WALLET BALANCE =================
export async function getWalletBalance() {
  try {
    const balance = await withRpcFailover(p =>
      p.getBalance(WALLET_ADDRESS)
    );
    return Number(ethers.formatEther(balance));
  } catch (err) {
    console.error("Balance fetch failed:", err.message);
    return 0;
  }
}

// ================= FILE RESET =================
function resetTradeConfig() {
  fs.writeFileSync(TRADE_FILE, JSON.stringify({}, null, 2));
}

function resetDailyPnL() {
  fs.writeFileSync(PNL_FILE, JSON.stringify({ lastBalance: 0 }, null, 2));
}

// ================= TRADE RECORD =================
export function recordTrade(type, amount, fee = 0) {
  if (type === "buy") {
    dailyTradeStats.buys++;
    dailyTradeStats.totalBuyVolume += amount;
  } else {
    dailyTradeStats.sells++;
    dailyTradeStats.totalSellVolume += amount;
  }
  dailyTradeStats.feesPaid += fee;
}

// ================= DAILY SUMMARY =================
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
  dailyTradeStats = { buys:0, sells:0, totalBuyVolume:0, totalSellVolume:0, feesPaid:0 };
  resetDailyPnL();
}

// ================= COMPUTE TRADE AMOUNT =================
export async function computeTradeAmount() {
  const sold = await allSellsComplete();
  if (!sold) return;

  resetTradeConfig();

  const bal = await getWalletBalance();
  if (bal <= 0) return;

  const totalGas = maxEntries * (buyGas + sellGas);
  const totalReserve = totalGas + backupAmount;
  const tradePerEntry = (bal - totalReserve) / maxEntries;

  if (tradePerEntry !== lastTradeAmount) {
    lastTradeAmount = tradePerEntry;
    currentTradeAmount = tradePerEntry;

    fs.writeFileSync(TRADE_FILE, JSON.stringify({
      balanceBefore: bal,
      totalGas,
      backupAmount,
      totalReserve,
      maxEntries,
      tradePerEntry,
      timestamp: Date.now()
    }, null, 2));

    await sendTelegram(
      `📊 *New Trade Round*\nTrade/Entry: ${tradePerEntry.toFixed(6)} BNB`
    );
  }
}

// ================= HEARTBEAT =================
export async function sendBalanceHeartbeat() {
  const bal = await getWalletBalance();
  await computeTradeAmount();
  lastBalance = bal;
}

export async function startLoop() {
  await sendBalanceHeartbeat();
  setInterval(sendBalanceHeartbeat, 60 * 60 * 1000);
  setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
}