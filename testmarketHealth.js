// file: testMarketBehaviorCheck.js
// Usage:
//   node testMarketBehaviorCheck.js
// or:
//   node testMarketBehaviorCheck.js <pair1> <pair2> ...

import "dotenv/config";
import { marketBehaviorCheck } from "./marketHealth.js";

const DEFAULT_PAIRS = [
  "0x76f5c6d207c4167129422dbefc0af5344e99bb4e",
  "0xb205ae2ca77c163bbd704b796c4dae1c594639ea"
];

async function runOne(pair) {
  try {
    const res = await marketBehaviorCheck(pair);

    console.log("\n==============================");
    console.log("PAIR:", pair);
    console.log("OK:", res?.ok === true ? "YES" : "NO");
    console.log("HEALTHY:", res?.isHealthy === true ? "YES" : "NO");
    console.log("SCORE:", res?.score ?? 0);
    console.log("TOKEN:", res?.token || "n/a");
    console.log("REASONS:", Array.isArray(res?.reasons) ? res.reasons.join(", ") : "n/a");
    console.log("------------------------------");
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.log("\n==============================");
    console.log("PAIR:", pair);
    console.log("ERROR:", e?.message || String(e));
  }
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const pairs = args.length ? args : DEFAULT_PAIRS;

  for (const p of pairs) {
    await runOne(p);
  }
}

main().catch((e) => {
  console.error("Fatal:", e?.message || String(e));
  process.exitCode = 1;
});