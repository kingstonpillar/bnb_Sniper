import "dotenv/config";
import { walletRate } from "./walletHistory.js";

// ---------------- TEST PAIRS ----------------
const PAIRS = [
  "0x0eD7e52944161450477ee417DE9Cd3a859b14fD0", // CAKE/WBNB
  "0x1B96B92314C44b159149f7E0303511fB2Fc4774f", // BUSD/WBNB
  "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae"  // USDT/WBNB
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