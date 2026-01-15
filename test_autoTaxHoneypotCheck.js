// file: test_autoTaxHoneypotCheck.js
// Run:
//   node test_autoTaxHoneypotCheck.js
//   node test_autoTaxHoneypotCheck.js <PAIR_ADDRESS>

import "dotenv/config";
import { autoTaxHoneypotCheck } from "./autoTaxHoneypotChecker.js";

const DEFAULT_PAIR = "0x298c4a3ee26f0e9151175a4f4354ea09eeae7628";

function pct(n) {
  return typeof n === "number" ? `${n.toFixed(2)}%` : "n/a";
}

async function main() {
  const pairAddress = process.argv[2] || DEFAULT_PAIR;

  console.log("Testing autoTaxHoneypotCheck");
  console.log("Pair:", pairAddress);

  try {
    const result = await autoTaxHoneypotCheck(pairAddress);

    const hp = result?.honeypotIs || {};
    const gp = result?.goPlusSecurity || {};

    console.log("\n=== SUMMARY ===");
    console.log("SAFE:", result?.safe === true ? "YES" : "NO");
    console.log("TOKEN:", result?.token || "n/a");
    console.log("PAIR :", result?.pair || "n/a");

    console.log("\n=== Honeypot.is ===");
    console.log("isHoneypot:", hp.isHoneypot === true ? "YES" : "NO");
    console.log(
      "taxes:",
      "buy", pct(hp.buyTax),
      "| sell", pct(hp.sellTax),
      "| transfer", pct(hp.transferTax)
    );

    console.log("\n=== GoPlus ===");
    console.log("signals:", gp.signals || null);

    console.log("\n=== RAW RESULT ===");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Test failed:", err?.message || err);
  }
}

main();