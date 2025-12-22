// file: testSecurityRealRPC.js
import dotenv from "dotenv";
dotenv.config();

import { securitySafety } from "./securitycheck2.js";

/*
  Use a REAL token with known liquidity.
  Example: BUSD, USDT, or any PancakeSwap token
*/
const TEST_TOKEN = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD

async function main() {
  console.log("🧪 Starting REAL RPC security test...");
  console.log("🔗 Token:", TEST_TOKEN);
  console.log("⏳ This will use real RPC calls (no txs)");

  const start = Date.now();

  try {
    const safe = await securitySafety(TEST_TOKEN);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    console.log("────────────────────────────");
    console.log("✅ Result:", safe ? "SAFE ✅" : "UNSAFE ❌");
    console.log("⏱️ Time elapsed:", `${elapsed}s`);
    console.log("📡 RPC status: OK (no revert)");
  } catch (err) {
    console.error("❌ RPC FAILURE / THROTTLE DETECTED");
    console.error(err.message);
  }
}

main();