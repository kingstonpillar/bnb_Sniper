import "dotenv/config";
import { walletRate } from "./walletHistory.js";

// ---------------- SELECTED TEST PAIRS (1 → 3) ----------------
// These are real WBNB-based pairs suitable for testing.
const PAIRS = [
  "0x4f199d8c0Ce0028e868C58d0CAa6A78bFa9BCd6D", // FLOKI / WBNB
  "0xD78c475133731cd54dadCb430F5c2b5d7E157cA8", // PEPE  / WBNB
  "0x6d6f2d86D81bA8aa62C8E58F7F3f39804370Ab7B"  // SFP   / WBNB
];

async function run() {
  for (const pair of PAIRS) {
    console.log("\n======================================");
    console.log(`Pair   : ${pair}`);

    try {
      const result = await walletRate(pair);

      console.log("Total Score :", result.totalScore);
      console.log("Health      :", result.health);
      console.log("Details     :");
      console.log(JSON.stringify(result.details, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
    }
  }
}

run();