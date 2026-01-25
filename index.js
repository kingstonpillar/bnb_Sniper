// index.js
// bnb_Sniper Engine Entry
// PM2 runs: pm2 start index.js --name bnb_Sniper
// This file owns ONLY orchestration (start/stop). No setInterval here.

import "dotenv/config";

// crash protection (startup ping + crash watchers + heartbeat)
import { startProtection, stopProtection } from "./crash-protection.js";

// listing scanner (writes potential_migrators.json)
import { startNewListingAlert, stopNewListingAlert } from "./newListingAlert.js";

// buy engine (reads potential_migrators.json and buys)
import { startBuyCaller, stopBuyCaller } from "./buyCaller.js";

// sell engine (reads active_positions.json and sells)
import { startSellCaller, stopSellCaller } from "./sellCaller.js";

// wallet engine (heartbeat + daily summary + compute watcher)
import { startWalletLoops, stopWalletLoops } from "./bnbWallet.js";

/* ================= ENGINE STATE ================= */
let engineRunning = false;
let stopping = false;

function logBootConfig() {
  const cfg = {
    NODE_ENV: process.env.NODE_ENV || "production",
    AUTO_BUY_OFFLINE: process.env.AUTO_BUY_OFFLINE,
    AUTO_SELL_DRY_RUN: process.env.AUTO_SELL_DRY_RUN,
    MAX_ENTRIES: process.env.MAX_ENTRIES,
    TICK_MS: process.env.TICK_MS,
    SELL_TICK_MS: process.env.SELL_TICK_MS,
    SCAN_INTERVAL_MS: process.env.SCAN_INTERVAL_MS,
  };
  console.log("[engine] boot config", cfg);
}

/* ================= START / STOP ================= */
export function startEngine() {
  if (engineRunning) {
    console.log("[engine] already running");
    return;
  }

  engineRunning = true;
  stopping = false;

  logBootConfig();

  // Order: protection first, then scanners/loops
  startProtection();

  // Listing scanner produces migrators -> buyCaller consumes it
  startNewListingAlert();

  // Buy + Sell loops
  startBuyCaller();
  startSellCaller();

  // Wallet loops (heartbeat + daily + compute watcher)
  startWalletLoops();

  console.log("[engine] started");
}

export async function stopEngine() {
  if (!engineRunning || stopping) {
    console.log("[engine] stop ignored", { engineRunning, stopping });
    return;
  }

  stopping = true;
  console.log("[engine] stopping...");

  // Stop in reverse dependency order
  // 1) stop buy/sell/scanner/wallet loops (timers)
  try {
    await stopBuyCaller();
  } catch (e) {
    console.error("[engine] stopBuyCaller error:", e?.message || e);
  }

  try {
    await stopSellCaller();
  } catch (e) {
    console.error("[engine] stopSellCaller error:", e?.message || e);
  }

  try {
    await stopNewListingAlert();
  } catch (e) {
    console.error("[engine] stopNewListingAlert error:", e?.message || e);
  }

  try {
    await stopWalletLoops();
  } catch (e) {
    console.error("[engine] stopWalletLoops error:", e?.message || e);
  }

  // 2) stop protection heartbeat (watchers remain installed)
  try {
    stopProtection();
  } catch (e) {
    console.error("[engine] stopProtection error:", e?.message || e);
  }

  engineRunning = false;
  stopping = false;

  console.log("[engine] stopped");
}

/* ================= PM2 FRIENDLY RUN ================= */
// Start immediately when index.js is executed by Node/PM2
startEngine();

/* ================= GRACEFUL SHUTDOWN ================= */
async function gracefulExit(signal) {
  console.log(`[engine] received ${signal}, shutting down...`);
  try {
    await stopEngine();
  } finally {
    // Let logs flush
    setTimeout(() => process.exit(0), 250);
  }
}

process.on("SIGINT", () => void gracefulExit("SIGINT"));
process.on("SIGTERM", () => void gracefulExit("SIGTERM"));

// Optional: if pm2 sends "shutdown" message
process.on("message", (msg) => {
  if (msg === "shutdown") {
    void gracefulExit("pm2:shutdown");
  }
});