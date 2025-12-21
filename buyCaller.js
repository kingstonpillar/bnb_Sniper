import fs from "fs";
import fetch from "node-fetch";
import { autoBuyToken } from "./swapExecutor.js";
import { securityPerfect } from "./securityPerfect.js";
import { securitySafety } from "./securitycheck2.js";
import { scanedPrice } from "./scanedPrice.js";
import { liquidityLock, lockTime } from "./liquidityCheck.js";
import { marketHealthPass } from "./marketHealth.js";

const POTENTIAL_MIGRATORS = "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function loadMigrators() {
  if (!fs.existsSync(POTENTIAL_MIGRATORS)) return [];
  try {
    return JSON.parse(fs.readFileSync(POTENTIAL_MIGRATORS, "utf8"));
  } catch {
    return [];
  }
}

function saveMigrators(data) {
  fs.writeFileSync(POTENTIAL_MIGRATORS, JSON.stringify(data, null, 2));
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    });
  } catch (err) {
    console.warn("Telegram send failed:", err.message);
  }
}

async function processToken(token) {
  const tokenMint = token.tokenmint.toLowerCase();
  const now = Date.now();

  try {
    /* ================= CALL ALL MODULES ================= */
    const scan = await scanedPrice(tokenMint);
    const secPerfect = await securityPerfect(tokenMint);
    const secSafety = await securitySafety(tokenMint);
    const marketPass = await marketHealthPass(tokenMint);
    const liqLocked = await liquidityLock(tokenMint);
    const lockGood = await lockTime(tokenMint);

    if (!scan || !secPerfect || !secSafety || !marketPass || !liqLocked || !lockGood) {
      console.log(`❌ ${tokenMint} failed one or more checks, skipping`);
      token.remove = true;
      return;
    }

    const priceNow = scan.priceBNB;

    // ---------------- ENTRY PRICE ----------------
    if (!token.entryPrice) {
      token.entryPrice = priceNow;
      token.entryTime = now;
      token.deleteTime = now + 10 * 60 * 1000;
      console.log(`ℹ️ Entry set for ${tokenMint}: ${priceNow} BNB`);
    }

    // Remove expired token
    if (now > token.deleteTime) {
      token.remove = true;
      console.log(`❌ ${tokenMint} expired`);
      return;
    }

    // ---------------- PRICE OFFSETS ----------------
    const rise = (priceNow - token.entryPrice) / token.entryPrice;
    let velocityTooHigh = false;
    let mcapLiquidityBad = false;
    let fakeFlowDetected = false;

    const dt = (now - token.entryTime) / 1000;
    if (dt > 0 && rise / dt > 0.003) velocityTooHigh = true;

    if (scan.marketCap && scan.liquidityBNB) {
      if (scan.marketCap / scan.liquidityBNB > 25) mcapLiquidityBad = true;
    }

    if (token.lastBNBReserve && scan.bnbReserve) {
      const bnbDelta = (scan.bnbReserve - token.lastBNBReserve) / token.lastBNBReserve;
      if (rise > 0.15 && bnbDelta < 0.03) fakeFlowDetected = true;
    }

    if (scan.riskScore >= 4 || velocityTooHigh || mcapLiquidityBad || fakeFlowDetected) {
      console.log(
        `❌ ${tokenMint} rejected: risk=${scan.riskScore}, velocity=${velocityTooHigh}, ` +
        `mcap/liquidity=${mcapLiquidityBad}, fakeFlow=${fakeFlowDetected}`
      );
      token.remove = true;
      await sendTelegram(
        `❌ ${tokenMint} rejected\n` +
        `Price: ${priceNow} BNB\nRise: ${(rise*100).toFixed(2)}%\n` +
        `Risk: ${scan.riskScore}, velocity=${velocityTooHigh}, mcap/liquidity=${mcapLiquidityBad}, fakeFlow=${fakeFlowDetected}`
      );
      return;
    }

    // Persist last BNB reserve
    token.lastBNBReserve = scan.bnbReserve;

    // ---------------- BUY CONDITION ----------------
    if (rise >= 0.10) {
      console.log(`🚀 BUY ${tokenMint} @ ${priceNow} BNB`);
      const txHash = await autoBuyToken(tokenMint);
      console.log(`✅ Swap executed: ${txHash}`);
      token.bought = true;
      token.remove = true;
      await sendTelegram(
        `🚀 BUY ${tokenMint}\nPrice: ${priceNow} BNB\nRise: ${(rise*100).toFixed(2)}%\nTxHash: ${txHash}`
      );
    } else {
      console.log(`⏳ ${tokenMint} rise ${(rise*100).toFixed(2)}%, waiting`);
      await sendTelegram(
        `⏳ ${tokenMint} monitoring\nPrice: ${priceNow} BNB\nRise: ${(rise*100).toFixed(2)}%\nRisk: ${scan.riskScore}`
      );
    }

  } catch (err) {
    console.error(`⚠️ Error processing ${tokenMint}:`, err.message);
  }
}

export async function buyCaller() {
  const migrators = loadMigrators();

  for (const token of migrators) {
    await processToken(token); // All modules recalled every interval
  }

  saveMigrators(migrators.filter(t => !t.remove));
}

/* ================= SET INTERVAL ================= */
setInterval(async () => {
  try {
    await buyCaller(); // Recalling all modules per token every 10 seconds
  } catch (err) {
    console.error("buyCaller error:", err.message);
  }
}, 10_000);