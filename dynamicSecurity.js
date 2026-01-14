// file: dynamicSecurity.js
import "dotenv/config";

import { marketBehaviorCheck } from "./marketHealth.js";
import { LPDrainMonitor as MarketPressureMonitor } from "./lpDrainMonitor.js";

let buyExecuted = false;

/**
 * Notify the system that a buy has occurred. Stops further retries.
 */
export function notifyBuyExecuted() {
  buyExecuted = true;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Dynamic buy gate:
 * - Mandatory observation window (default 5 minutes)
 * - Uses ONLY real chain behavior (no eth_call)
 * - Requires consecutive clean passes after observation
 *
 * @param {string} pairAddress
 * @param {string} tokenIn
 * @param {object} options
 */
export async function checkBuySafety(pairAddress, tokenIn, options = {}) {
  const pollInterval = Number(options.pollInterval ?? 10_000);
  const cooldownMinutes = Number(options.cooldownMinutes ?? 2);

  const observationMinutes = Number(options.observationMinutes ?? 5);
  const maxWaitMs = Number(options.maxWaitMinutes ?? 15) * 60 * 1000;
  const requiredConsecutivePasses = Number(options.requiredConsecutivePasses ?? 2);

  const startTime = Date.now();
  const observationEnd = startTime + observationMinutes * 60 * 1000;

  const lpMonitor = new MarketPressureMonitor(
    pairAddress,
    tokenIn,
    pollInterval,
    cooldownMinutes
  );

  let consecutivePasses = 0;

  try {
    while (Date.now() - startTime < maxWaitMs) {
      if (buyExecuted) {
        return { safeToBuy: true, reasons: ["BUY_EXECUTED"] };
      }

      const now = Date.now();
      const observationOver = now >= observationEnd;
      const reasons = [];

      /* ================= 1) MARKET BEHAVIOR ================= */
      let market = null;
      try {
        market = await marketBehaviorCheck(pairAddress);
        if (!market?.ok) reasons.push("MARKET_BEHAVIOR_ERROR");
        else if (!market.isHealthy) reasons.push("MARKET_BEHAVIOR_FAIL");
      } catch {
        reasons.push("MARKET_BEHAVIOR_ERROR");
      }

      /* ================= 2) LP PRESSURE ================= */
      let lpStatus = null;
      try {
        lpStatus = await lpMonitor.check();
        if (!lpStatus?.safeToBuy) {
          reasons.push(`LP_MONITOR_${lpStatus?.reason || "FAIL"}`);
        }
      } catch {
        reasons.push("LP_MONITOR_ERROR");
      }

      /* ================= OBSERVATION PHASE ================= */
      if (!observationOver) {
        consecutivePasses = 0;

        console.log(
          `OBSERVING: ${Math.round((now - startTime) / 1000)}s / ${
            observationMinutes * 60
          }s | ` +
            `MB: ${market?.isHealthy ? "OK" : "FAIL"} | ` +
            `LP: ${lpStatus?.reason || "ERR"}`
        );

        await sleep(pollInterval);
        continue;
      }

      /* ================= POST-OBSERVATION ================= */
      const clean = reasons.length === 0;

      if (clean) consecutivePasses++;
      else consecutivePasses = 0;

      if (consecutivePasses >= requiredConsecutivePasses) {
        return {
          safeToBuy: true,
          reasons: [],
          market,
          lpStatus,
          meta: {
            observationMinutes,
            pollInterval,
            requiredConsecutivePasses,
            consecutivePasses
          }
        };
      }

      console.log(
        `POST-OBS: ${consecutivePasses}/${requiredConsecutivePasses} clean passes | ` +
          `MB: ${market?.isHealthy ? "OK" : "FAIL"} | ` +
          `LP: ${lpStatus?.reason || "ERR"}`
      );

      await sleep(pollInterval);
    }

    return { safeToBuy: false, reasons: ["MAX_WAIT_EXPIRED"] };
  } finally {
    try {
      lpMonitor.stop();
    } catch {}
  }
}