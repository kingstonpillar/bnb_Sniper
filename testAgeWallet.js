// file: testWalletRate.js
// Usage:
//   node testWalletRate.js
// or:
//   node testWalletRate.js 0xcb540e74cc4100ad6a60d550ca8bbcb365c11549 0x76f5c6d207c4167129422dbefc0af5344e99bb4e

import "dotenv/config";
import { walletRate } from "./walletHistory.js";

const DEFAULT_INPUTS = [
  "0xcb540e74cc4100ad6a60d550ca8bbcb365c11549",
  "0x76f5c6d207c4167129422dbefc0af5344e99bb4e"
];

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const inputs = args.length ? args : DEFAULT_INPUTS;

  for (const input of inputs) {
    try {
      const res = await walletRate(input);

      console.log("\n==============================");
      console.log("INPUT:", input);
      console.log("PASS:", res?.pass === true ? "YES" : "NO");
      console.log("SCORE:", `${res?.totalScore ?? 0}/${res?.totalPossible ?? 80}`);
      console.log("TYPE:", res?.type || "UNKNOWN");
      console.log("TOKEN:", res?.tokenAddress || "n/a");
      console.log("PAIR :", res?.pairAddress || "n/a");
      console.log("REASON:", res?.reason || "n/a");
      console.log("------------------------------");
      console.log(JSON.stringify(res, null, 2));
    } catch (e) {
      console.log("\n==============================");
      console.log("INPUT:", input);
      console.log("ERROR:", e?.message || String(e));
    }
  }
}

main();
```0