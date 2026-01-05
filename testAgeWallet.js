import "dotenv/config";
import { walletRate } from "./walletHistory.js";

// ===================== TEST PAIRS (PANCAKESWAP V2) =====================
const PAIRS = [
  {
    name: "CAKE / WBNB",
    address: "0x0eD7e52944161450477ee417DE9Cd3a859b14fD0"
  },
  {
    name: "BUSD / WBNB",
    address: "0x1B96B92314C44b159149f7E0303511fB2Fc4774f"
  },
  {
    name: "USDT / WBNB",
    address: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae"
  }
];

// ===================== RUN =====================
async function run() {
  for (const pair of PAIRS) {
    console.log("\n======================================");
    console.log(`Pair   : ${pair.name}`);
    console.log(`Address: ${pair.address}`);

    try {
      const result = await walletRate(pair.address);

      const score = Number(result.totalScore);
      const health = score === 100 ? "HEALTHY ✅" : "UNHEALTHY ❌";

      console.log("Total Score :", score);
      console.log("Health      :", health);

      console.log("Details:");
      console.log(JSON.stringify(result.details, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
    }
  }
}

run();