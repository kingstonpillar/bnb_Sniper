import fs from "fs";
import path from "path";
import process from "process";
import fetch from "node-fetch"; // for Telegram messages

// === TELEGRAM CONFIG ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === LOG SETUP ===
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const LOG_FILE = path.join(LOG_DIR, "crash.log");
const COUNT_FILE = path.join(LOG_DIR, "restart-count.txt");

// === RESTART COUNT ===
let restartCount = 0;
if (fs.existsSync(COUNT_FILE)) {
  try {
    restartCount = parseInt(fs.readFileSync(COUNT_FILE, "utf8"), 10) || 0;
  } catch {
    restartCount = 0;
  }
}
restartCount++;
fs.writeFileSync(COUNT_FILE, String(restartCount), "utf8");

const startTime = Date.now();

// === HELPERS ===
function formatDuration(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hr = Math.floor(ms / (1000 * 60 * 60));
  return `${hr}h ${min}m ${sec}s`;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }
}

function logError(type, error) {
  const uptime = formatDuration(Date.now() - startTime);
  const entry = `[${new Date().toISOString()}] [${type}] [Uptime: ${uptime}] ${
    error?.stack || error
  }\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.error(entry);

  sendTelegram(
    `⚠️ [${type}] Bot error\n⏱️ Uptime before crash: ${uptime}\n\n${
      error?.message || error
    }`
  );
}

// === CRASH WATCHERS ===
process.on("uncaughtException", (err) => logError("UncaughtException", err));
process.on("unhandledRejection", (reason) => logError("UnhandledRejection", reason));

// === HOURLY MEMORY PING ALERT ===
let memoryPingInterval;

function startMemoryPing() {
  memoryPingInterval = setInterval(() => {
    const uptime = formatDuration(Date.now() - startTime);
    const usedMB = process.memoryUsage().rss / 1024 / 1024;

    // Telegram hourly ping
    sendTelegram(
      `⏱ Hourly ping: Bot alive\nUptime: ${uptime}\nMemory usage: ${usedMB.toFixed(
        2
      )} MB`
    );

    // Clean memory log if usage exceeds 1000MB
    if (usedMB > 1000) {
      try {
        fs.writeFileSync(LOG_FILE, ""); // clear crash log
        console.log(`🧹 Memory cleanup: cleared crash log at ${usedMB.toFixed(2)} MB`);
      } catch (err) {
        console.error("Failed to clear crash log:", err);
      }
    }
  }, 60 * 60 * 1000); // hourly
}

function stopMemoryPing() {
  if (memoryPingInterval) {
    clearInterval(memoryPingInterval);
    memoryPingInterval = null;
  }
}

// === START/STOP CONTROL ===
let isBotRunning = false;

export function startBot() {
  if (isBotRunning) {
    console.log("[bot] Bot already running.");
    return;
  }

  isBotRunning = true;

  // Bot initialization logic
  console.log("[bot] Starting bot...");

  // Send start alert
  const ts = new Date().toISOString();
  sendTelegram(
    `🚀 bnb_Sniper Bot started\n🕒 ${ts}\n🔄 Restart count: ${restartCount}`
  );

  // Start memory ping
  startMemoryPing();

  console.log("[bot] Bot started successfully.");
}

export function stopBot() {
  if (!isBotRunning) {
    console.log("[bot] Bot not running.");
    return;
  }

  isBotRunning = false;

  // Stop memory ping
  stopMemoryPing();

  // Send stop alert
  sendTelegram(`🛑 bnb_Sniper Bot stopped`);

  console.log("[bot] Bot stopped successfully.");
}

// ================= LOOPS (PM2 FRIENDLY) =================
export function startWalletLoops({
  heartbeatMs = 60 * 60 * 1000, // hourly
  dailyMs = 24 * 60 * 60 * 1000, // daily
  computeMs = 30 * 1000, // fast watcher for allSellsComplete
} = {}) {
  startBot(); // Start crash protection
  
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
  startBot(); // Ensures bot starts automatically when running directly
}