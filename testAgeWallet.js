import "dotenv/config";
import { walletRate } from "./walletHistory.js";

// ---------------- TEST TOKENS ----------------
const TOKENS = [
  { name: "SAFU", address: "0x3f2B10F3327ea2337C524eEf23F4cd61bC364444" },
  { name: "Salamanca", address: "0x42fE1937E1db4F11509e9f7FdD97048BD8d04444" },
  { name: "WBNB", address: process.env.WBNB_ADDRESS }
];

// ---------------- RUN ----------------
async function run() {
  for (const token of TOKENS) {
    console.log("\n======================================");
    console.log(`Token: ${token.name}`);
    console.log(`Address: ${token.address}`);

    try {
      const result = await walletRate(token.address);

      const score = Number(result.totalScore);
      const health = score >= 80 ? "HEALTHY ✅" : "UNHEALTHY ❌";

      console.log("Total Score :", score);
      console.log("Health      :", health);

      // Full breakdown (important for debugging logic)
      console.log("Details:");
      console.log(JSON.stringify(result.details, null, 2));
    } catch (err) {
      console.error("ERROR:", err.message);
    }
  }
}

run();