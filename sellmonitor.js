// sellmonitor.js
// Tracks active positions + compounding + PM2 auto-stop when max rounds reached
// Added: synchronous file-locking to prevent concurrent file corruption
// Note: exports and function signatures preserved.

import fs from "fs";
import dotenv from "dotenv";
import { exec } from "child_process";
import fetch from "node-fetch";

dotenv.config();

// ================================
// FILES
// ================================
const ACTIVE_FILE = "./active_positions.json";
const POTENTIAL_FILE = "./potential_migrators.json";
const COUNTER_FILE = "./_compound_counter.json";

// ================================
// ENV CONFIG
// ================================
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || "20", 10);
const MAX_COMPOUNDING_CYCLES = parseInt(process.env.MAX_COMPOUNDING_CYCLES || "3", 10);

// Optional: if you set this to "true", compounding counter resets after every all-sold.
// Warning: this defeats "stop after max cycles" behavior.
const RESET_COUNTER_ON_ALL_SOLD = String(process.env.RESET_COUNTER_ON_ALL_SOLD || "false").toLowerCase() === "true";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOT_PROCESS_NAME = process.env.BOT_PROCESS_NAME || "auto-trader";

// ================================
// FILE LOCK HELPERS (synchronous)
// ================================

function getLockFile(path) {
  return path + ".lock";
}

// small synchronous sleep using Atomics.wait
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function acquireLockSync(path, timeoutMs = 5000) {
  const lock = getLockFile(path);
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid || 0));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (Date.now() - start > timeoutMs) {
        try {
          const st = fs.statSync(lock);
          const age = Date.now() - st.mtimeMs;
          if (age > 60_000) {
            try { fs.unlinkSync(lock); } catch {}
          }
        } catch {}
      }
      sleepSync(15);
    }
  }
}

function releaseLockSync(path) {
  const lock = getLockFile(path);
  try {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {}
}

function safeReadJSONSync(path) {
  acquireLockSync(path);
  try {
    if (!fs.existsSync(path)) return null;
    const raw = fs.readFileSync(path, "utf8");
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  } finally {
    releaseLockSync(path);
  }
}

function safeWriteJSONSync(path, obj) {
  acquireLockSync(path);
  try {
    const tmp = path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, path);
  } finally {
    releaseLockSync(path);
  }
}

// ================================
// Compounding counter (persistent)
// ================================
function loadCounter() {
  const data = safeReadJSONSync(COUNTER_FILE);
  if (!data) return 0;
  return Number(data.Comp_Count || 0);
}

function saveCounter(count) {
  safeWriteJSONSync(COUNTER_FILE, { Comp_Count: count });
}

function resetCounter() {
  safeWriteJSONSync(COUNTER_FILE, { Comp_Count: 0 });
}

let compoundingCount = loadCounter();

/**
 * =========================================
 * 📩 Telegram alert helper
 * =========================================
 */
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("⚠️ Telegram send failed:", err.message);
  }
}

/**
 * =========================================
 * 📈 Register new active position on BUY
 * =========================================
 */
export function markSellStart(tokenMint, buyPrice = 0) {
  let active = safeReadJSONSync(ACTIVE_FILE);
  if (!Array.isArray(active)) active = [];

  if (!active.find((t) => t.tokenMint === tokenMint)) {
    if (active.length >= MAX_ENTRIES) {
      console.warn(`⚠️ Max active limit (${MAX_ENTRIES}) reached → removing oldest entry.`);
      active.shift();
    }

    active.push({
      tokenMint,
      buyPrice,
      status: "active",
      timestamp: Date.now(),
    });

    safeWriteJSONSync(ACTIVE_FILE, active);
    console.log(`📈 Added new active position: ${tokenMint}`);
  }
}

/**
 * =========================================
 * 💸 Mark token as SOLD
 * =========================================
 */
export function markSellComplete(tokenMint) {
  const activeRaw = safeReadJSONSync(ACTIVE_FILE);
  if (!Array.isArray(activeRaw)) return;

  const index = activeRaw.findIndex((t) => t.tokenMint === tokenMint);
  if (index !== -1) {
    activeRaw[index].status = "sold";
    activeRaw[index].soldAt = Date.now();
    safeWriteJSONSync(ACTIVE_FILE, activeRaw);
    console.log(`💸 Marked SOLD: ${tokenMint}`);
  }
}

/**
 * =========================================
 * 🧹 Clear files for new entry session
 * =========================================
 */
function clearForNextEntry() {
  try { safeWriteJSONSync(ACTIVE_FILE, []); } catch {}
  try { safeWriteJSONSync(POTENTIAL_FILE, []); } catch {}
}

/**
 * =========================================
 * 🔁 Check if all sells are complete
 * Trigger compounding & PM2 auto-stop
 * =========================================
 */
export async function allSellsComplete() {
  const activeRaw = safeReadJSONSync(ACTIVE_FILE);

  // No active positions means "nothing to wait for"
  if (!Array.isArray(activeRaw) || activeRaw.length === 0) {
    // Keep everything clean anyway
    clearForNextEntry();
    return true;
  }

  const allSold = activeRaw.every((t) => t.status === "sold");
  if (!allSold) return false;

  // Clear state for next entry window
  clearForNextEntry();

  // Counter policy
  if (RESET_COUNTER_ON_ALL_SOLD) {
    compoundingCount = 0;
    resetCounter();
    await sendTelegram("✅ *All sells complete — state cleared (counter reset)*");
    return true;
  }

  // Increment compounding count
  compoundingCount++;
  saveCounter(compoundingCount);

  console.log(`✅ Compounding Round ${compoundingCount}/${MAX_COMPOUNDING_CYCLES}`);
  await sendTelegram(`✅ *Compounding Round ${compoundingCount}/${MAX_COMPOUNDING_CYCLES} Completed*`);

  // Stop bot if max cycles reached
  if (compoundingCount >= MAX_COMPOUNDING_CYCLES) {
    console.log("🛑 Maximum compounding cycles reached. Stopping bot via PM2...");
    await sendTelegram("🛑 *All compounding cycles complete — bot stopping automatically!*");

    // Delete counter file BEFORE stopping the bot
    try { fs.unlinkSync(COUNTER_FILE); } catch {}

    exec(`pm2 stop ${BOT_PROCESS_NAME}`, (err) => {
      if (err) {
        console.error("⚠️ PM2 stop failed:", err.message);
      } else {
        console.log(`✅ PM2 process '${BOT_PROCESS_NAME}' stopped successfully.`);
      }
    });
  }

  // Critical fix: must return true here
  return true;
}