// file: test_securitySafety.js
// Run:
//   node test_securitySafety.js
// Or:
//   node test_securitySafety.js <pairAddress> <tokenMint>

import "dotenv/config";
import { securitySafety } from "./securitycheck2.js";

const DEFAULT_PAIR = "0x298c4a3ee26f0e9151175a4f4354ea09eeae7628";
const DEFAULT_TOKEN = "0xf9c6e80e9a5807a1214a79449009b48104f94444";

function pickArg(i, fallback) {
  const v = process.argv[i];
  return v && v.trim() ? v : fallback;
}

(async () => {
  const pair = pickArg(2, process.env.TEST_PAIR || DEFAULT_PAIR);
  const tokenMint = pickArg(3, process.env.TEST_TOKEN || DEFAULT_TOKEN);

  console.log("Testing securitySafety");
  console.log("PAIR :", pair);
  console.log("TOKEN:", tokenMint);
  console.log("");

  try {
    const result = await securitySafety(pair, tokenMint);

    console.log("=== SUMMARY ===");
    console.log("OK        :", result.ok);
    console.log("PASS      :", result.pass);
    console.log("REASON    :", result.reason);
    console.log("SCORE     :", `${result.score}/${result.maxScore}`);
    console.log("THRESHOLD :", result.passThreshold);
    console.log("TOKENPAIR :", result.token);
    console.log("MISMATCH  :", result.tokenMismatch);
    console.log("");

    console.log("=== BREAKDOWN ===");
    console.table(result.breakdown || {});
    console.log("");

    console.log("=== FLAGS / REASONS ===");
    console.log(result.reasons || []);
    console.log("");

    console.log("=== FULL RESULT ===");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("securitySafety test failed");
    console.error(err?.message || err);
    process.exitCode = 1;
  }
})();