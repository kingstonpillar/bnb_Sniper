// crash-protection.js — controlled version (no auto timers on import)
import fs from "fs";
import path from "path";
import process from "process";
import fetch from "node-fetch"; // Telegram messages

// === TELEGRAM CONFIG ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === LOG SETUP ===
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, "crash.log");
const COUNT_FILE = path.join(LOG_DIR, "restart-count.txt");

// ----- module-level state -----
let restartCount = 0;
let startTime = Date.now();
let heartbeatTimer = null;
let watchersInstalled = false;

// === RESTART COUNT (evaluated once on import, safe) ===
if (fs.existsSync(COUNT_FILE)) {
  try {
    restartCount = parseInt(fs.readFileSync(COUNT_FILE, "utf8"), 10) || 0;
  } catch {
    restartCount = 0;
  }
}
restartCount += 1;
fs.writeFileSync(COUNT_FILE, String(restartCount), "utf8");

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
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("Failed to send Telegram message:", err?.message || err);
  }
}

function logError(type, error) {
  const uptime = formatDuration(Date.now() - startTime);
  const entry = `[${new Date().toISOString()}] [${type}] [Uptime: ${uptime}] ${
    error?.stack || error
  }\n`;

  try {
    fs.appendFileSync(LOG_FILE, entry);
  } catch (e) {
    console.error("[crash-protection] failed to write crash log:", e?.message || e);
  }

  console.error(entry);

  void sendTelegram(
    `⚠️ [${type}] bnb_Sniper error\n⏱️ Uptime before crash: ${uptime}\n\n${
      error?.message || String(error)
    }`
  );
}

function installCrashWatchersOnce() {
  if (watchersInstalled) return;
  watchersInstalled = true;

  process.on("uncaughtException", (err) => logError("UncaughtException", err));
  process.on("unhandledRejection", (reason) => logError("UnhandledRejection", reason));
}

// === HOURLY MEMORY PING ===
function startHeartbeat() {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const uptime = formatDuration(Date.now() - startTime);
    const usedMB = process.memoryUsage().rss / 1024 / 1024;

    void sendTelegram(
      `⏱ Hourly ping: bnb_Sniper alive\nUptime: ${uptime}\nMemory usage: ${usedMB.toFixed(
        2
      )} MB`
    );

    // Clean memory log if usage exceeds 1000MB
    if (usedMB > 1000) {
      try {
        fs.writeFileSync(LOG_FILE, "");
        console.log(
          `🧹 Memory cleanup: cleared crash log at ${usedMB.toFixed(2)} MB`
        );
      } catch (err) {
        console.error("Failed to clear crash log:", err?.message || err);
      }
    }
  }, 60 * 60 * 1000); // hourly
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// === EXPORTS ===

/**
 * One-time startup notification (kept as your existing API: import { protect } ...)
 */
export function protect() {
  console.log("✅ Crash protection enabled (bnb_Sniper)");
  const ts = new Date().toISOString();

  void sendTelegram(
    `🚀 bnb_Sniper started\n🕒 ${ts}\n🔄 Restart count: ${restartCount}`
  );
}

/**
 * Start everything (watchers + heartbeat + startup ping).
 * Call this from index.js once, not from this module automatically.
 */
export function startProtection() {
  installCrashWatchersOnce();
  startTime = Date.now(); // reset uptime baseline for this run
  protect();
  startHeartbeat();
  console.log("[crash-protection] started");
}

/**
 * Stop timers (watchers remain installed; Node does not support removing them safely in general)
 */
export function stopProtection() {
  stopHeartbeat();
  console.log("[crash-protection] stopped");
}

// Testing function
if (require.main === module) {
  startProtection();
}