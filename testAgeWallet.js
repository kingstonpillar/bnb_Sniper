// testWalletHistory.js
import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js";

/* ================= CONFIG ================= */

// Reputable tokens on BSC
const TOKENS = [
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", // CAKE - PancakeSwap
  "0x1318489c426e032465edbda5a1d32023923afb87"  // BUSD - Stablecoin
].map(t => t.toLowerCase());

/* ================= RUN TEST ================= */
async function run() {
  for (const token of TOKENS) {
    try {
      console.log(`\n🔎 Testing token: ${token}`);

      // Run walletRate for the token
      const result = await walletRate(token);

      // Show full output
      console.dir(result, { depth: null });
    } catch (err) {
      console.error(`❌ Error testing ${token}:`, err.message);
    }
  }

  process.exit(0);
}

run();