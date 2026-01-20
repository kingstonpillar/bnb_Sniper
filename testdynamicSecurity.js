// file: test_dynamicSecurity_noenv.js
// run with: node test_dynamicSecurity_noenv.js

import { checkBuySafety } from "./dynamicSecurity.js";

// HARD-CODED TEST INPUTS (no .env)
const PAIR_ADDRESS = "0x298c4a3ee26f0e9151175a4f4354ea09eeae7628";
const TOKEN_IN     = "0xf9c6e80e9a5807a1214a79449009b48104f94444";

async function main() {
  console.log("[TEST] dynamicSecurity.checkBuySafety START");
  console.log({
    pairAddress: PAIR_ADDRESS,
    tokenIn: TOKEN_IN
  });

  try {
    const result = await checkBuySafety(PAIR_ADDRESS, TOKEN_IN, {
      pollInterval: 10_000,
      cooldownMinutes: 2,
      maxWaitMinutes: 1,              // short test window
      requiredConsecutivePasses: 1    // relax for testing
    });

    console.log("[TEST] RESULT");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("[TEST] ERROR", err?.message || err);
  }
}

main();