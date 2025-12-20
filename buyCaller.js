import fs from "fs";
import { autoBuyToken } from "./swapExecutor.js";
import { securityPerfect } from "./securityPerfect.js";
import { securitySafety } from "./securitycheck2.js";
import { scanedPrice } from "./scanedPrice.js";
import { liquidityLock, lockTime } from "./liquidityCheck.js";
import { marketHealthPass } from "./marketHealth.js";  // <-- import here

const POTENTIAL_MIGRATORS = "./potential_migrators.json";

// ... your load/save functions unchanged ...

export async function buyCaller() {
  const migrators = loadMigrators();
  const now = Date.now();

  for (const token of migrators) {
    const tokenMint = token.tokenmint.toLowerCase();

    // Set entry timestamp and price
    if (!token.entryTime) token.entryTime = now;
    if (!token.entryPrice) {
      const price = await scanedPrice(tokenMint);
      if (!price) continue;
      token.entryPrice = price;
      token.deleteTime = token.entryTime + 10 * 60 * 1000;
      console.log(`ℹ️ Token ${tokenMint} entry price set: ${price} BNB`);
      continue;
    }

    if (token.remove || now > token.deleteTime) {
      token.remove = true;
      console.log(`❌ Token ${tokenMint} exceeded 10-min window, removing`);
      continue;
    }

    try {
      const priceNow = await scanedPrice(tokenMint);
      if (!priceNow) continue;

      const rise = (priceNow - token.entryPrice) / token.entryPrice;
      if (rise < 0.10) {
        console.log(`⏳ Token ${tokenMint} has not risen 10% yet (${(rise*100).toFixed(2)}%)`);
        continue;
      }

      // ----------------- SECURITY -----------------
      const secPerfect = await securityPerfect(tokenMint);
      if (!secPerfect) {
        console.log(`❌ Token ${tokenMint} failed securityPerfect check`);
        token.remove = true;
        continue;
      }

      const secSafety = await securitySafety(tokenMint);
      if (!secSafety) {
        console.log(`❌ Token ${tokenMint} failed securitySafety check`);
        token.remove = true;
        continue;
      }

      // ----------------- MARKET HEALTH -----------------
      const marketPass = await marketHealthPass(tokenMint);
      if (!marketPass) {
        console.log(`❌ Token ${tokenMint} failed market health check`);
        token.remove = true;
        continue;
      }

      // ----------------- LIQUIDITY -----------------
      const liqLocked = await liquidityLock(tokenMint);
      const lockGood = await lockTime(tokenMint);
      if (!liqLocked || !lockGood) {
        console.log(`❌ Token ${tokenMint} failed liquidity lock check`);
        token.remove = true;
        continue;
      }

      // ----------------- EXECUTE BUY -----------------
      console.log(`🚀 Buying token ${tokenMint} at price ${priceNow} BNB`);
      const txHash = await autoBuyToken(tokenMint);
      console.log(`✅ Swap executed: ${txHash}`);

      token.bought = true;
      token.remove = true;

    } catch (err) {
      console.error(`⚠️ Error processing token ${tokenMint}:`, err.message);
    }
  }

  // Remove flagged tokens
  const updated = migrators.filter(t => !t.remove);
  saveMigrators(updated);
}

setInterval(() => {
  buyCaller().catch(err => {
    console.error("buyCaller error:", err.message);
  });
}, 10_000); // 10 seconds