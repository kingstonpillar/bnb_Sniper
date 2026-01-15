// file: test_autoTaxHoneypotCheck.js
// Run: node test_autoTaxHoneypotCheck.js
// Or:  node test_autoTaxHoneypotCheck.js 0x298c4a3ee26f0e9151175a4f4354ea09eeae7628

import "dotenv/config";
import { autoTaxHoneypotCheck } from "./autoTaxHoneypotChecker.js"; // change path/name to your actual file

const DEFAULT_PAIR = "0x298c4a3ee26f0e9151175a4f4354ea09eeae7628";

function pct(n) {
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "n/a";
}

(async () => {
  const pairAddress = process.argv[2] || process.env.TEST_PAIR || DEFAULT_PAIR;

  try {
    console.log("Testing autoTaxHoneypotCheck...");
    console.log("Pair:", pairAddress);

    const result = await autoTaxHoneypotCheck(pairAddress);

    console.log("\n=== SUMMARY ===");
    console.log("safe:", Boolean(result?.safe));
    console.log("token:", result?.token);
    console.log("pair:", result?.pair);

    const hp = result?.honeypotIs || {};
    console.log("honeypot.is -> isHoneypot:", Boolean(hp?.isHoneypot));
    console.log("taxes -> buy:", pct(hp?.buyTax), "sell:", pct(hp?.sellTax), "transfer:", pct(hp?.transferTax));

    const gp = result?.goPlusSecurity || {};
    console.log("goplus -> signals:", gp?.signals || null);

    console.log("\n=== RAW JSON ===");
    console.log(JSON.stringify(result, null, 2));

    // exit code useful for automation
    process.exitCode = result?.safe ? 0 : 1;
  } catch (err) {
    console.error("Test failed:", err?.message || err);
    process.exitCode = 2;
  }
})();
```0