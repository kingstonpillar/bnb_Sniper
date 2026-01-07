import "dotenv/config";
import { walletRate } from "./walletHistory.js";

// ---------------- SELECTED TEST PAIRS (1 → 3) ----------------
// These are the THREE new tokens you provided.
const PAIRS = [
  "0xd14e5639f8bc41fcd66ea571f29780b9c7927ff4", // JOJOWORLD (your entry)
  "0xfa9b8fe912290d9fae70deec6f174ee0bf2be05d90961d360c5f97d8d07bc033", // ⚠ INVALID BSC ADDRESS
  "0x74471cde9b16f67a540112ea24844924a75220b0"  // YOUJUCOIN (your entry)
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