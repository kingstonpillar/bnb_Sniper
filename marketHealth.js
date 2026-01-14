// file: test_marketHealth.js
// Run:
//   node test_marketHealth.js
//
// Notes:
// - marketBehaviorCheck expects a PAIR address (LP contract), not the token address.
// - This script is standalone: no TEST_PAIR in .env is required.

import "dotenv/config";
import { marketBehaviorCheck } from "./MarketHeath.js"; // keep exact filename as you wrote

const PAIR_ADDRESS = "0xcb540e74cc4100ad6a60d550ca8bbcb365c11549";

(async () => {
  try {
    console.log("Testing marketBehaviorCheck...");
    console.log("Pair:", PAIR_ADDRESS);

    const res = await marketBehaviorCheck(PAIR_ADDRESS);

    console.log("\n=== SUMMARY ===");
    console.log("ok:", Boolean(res?.ok));
    console.log("isHealthy:", Boolean(res?.isHealthy));
    console.log("score:", Number(res?.score ?? 0));
    console.log("pair:", res?.pair || PAIR_ADDRESS);
    console.log("token:", res?.token || null);
    console.log("wbnb:", res?.wbnb || null);

    if (Array.isArray(res?.reasons) && res.reasons.length) {
      console.log("reasons:", res.reasons.join(", "));
    } else {
      console.log("reasons: (none)");
    }

    console.log("\n=== RAW JSON ===");
    console.log(JSON.stringify(res, null, 2));

    // exit code useful for bots/CI
    process.exitCode = res?.ok && res?.isHealthy ? 0 : 1;
  } catch (e) {
    console.error("Test failed:", e?.message || e);
    process.exitCode = 2;
  }
})();
```0