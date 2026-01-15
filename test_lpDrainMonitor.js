// file: test_lpDrainMonitor.js
// Run:
//   node test_lpDrainMonitor.js
//
// Notes:
// - Uses a hardcoded PAIR address (no .env TEST_PAIR needed).
// - Requires READ_RPC_1 and READ_RPC_2 in .env (per LPDrainMonitor constructor).
// - Requires WBNB_ADDRESS in .env (or set it below if you prefer hardcode).

import "dotenv/config";
import { LPDrainMonitor } from "./lpDrainMonitor.js";

const PAIR_ADDRESS = "0xcb540e74cc4100ad6a60d550ca8bbcb365c11549";
const WBNB_ADDRESS =
  process.env.WBNB_ADDRESS || "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

// Optional: quick tuning for tests
const POLL_MS = 10_000;        // same default as class
const COOLDOWN_MIN = 2;        // same default as class
const RUN_FOR_MS = 60_000;     // stop after 60s (adjust as you like)

function fmtBps(n) {
  if (!Number.isFinite(n)) return "n/a";
  const pct = (n / 100).toFixed(2);
  return `${n} bps (${pct}%)`;
}

(async () => {
  try {
    console.log("Starting LPDrainMonitor test...");
    console.log("Pair:", PAIR_ADDRESS);
    console.log("WBNB:", WBNB_ADDRESS);
    console.log("Poll:", `${POLL_MS}ms`);
    console.log("RunFor:", `${RUN_FOR_MS}ms`);
    console.log("");

    const mon = new LPDrainMonitor(PAIR_ADDRESS, WBNB_ADDRESS, POLL_MS, COOLDOWN_MIN, {
      drainMinBps: 250,              // 2.50% LP drain threshold
      heavySellPriceDropBps: 500,    // 5.00% price drop
      lightSellPriceDropBps: 150     // 1.50% price drop
    });

    // Print each emitted status
    mon.onSignal((s) => {
      const ts = new Date(s.timestamp || Date.now()).toISOString();

      if (!s.ok) {
        console.log(`[${ts}] ok=false reason=${s.reason} rpc=${s.rpc}`);
        console.log(`  error: ${s.error}`);
        return;
      }

      console.log(
        `[${ts}] ok=true safeToBuy=${s.safeToBuy} reason=${s.reason} rpc=${s.rpc}`
      );
      console.log(
        `  reserves: token=${s.reserves.tokenReserve} wbnb=${s.reserves.wbnbReserve}`
      );
      console.log(`  priceScaled(1e18): ${s.priceScaled}`);

      if (s.cooldownUntil && Number(s.cooldownUntil) > Date.now()) {
        const leftMs = Number(s.cooldownUntil) - Date.now();
        console.log(`  cooldown: active (${Math.ceil(leftMs / 1000)}s left)`);
      }
    });

    // Do an immediate check once (so you see output right away)
    const first = await mon.check();
    console.log("\n=== FIRST CHECK RAW JSON ===");
    console.log(JSON.stringify(first, null, 2));
    console.log("");

    // Then start polling
    mon.start();

    // Auto-stop after RUN_FOR_MS
    setTimeout(() => {
      mon.stop();
      console.log("\nLPDrainMonitor test finished.");
      // exit code: 0 if last known status ok and safeToBuy, else 1
      process.exitCode = first?.ok && first?.safeToBuy ? 0 : 1;
    }, RUN_FOR_MS);
  } catch (e) {
    console.error("Test failed:", e?.message || e);
    process.exitCode = 2;
  }
})();
