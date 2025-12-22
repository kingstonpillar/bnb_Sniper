// file: testMarketHealth.js
import dotenv from "dotenv";
import { marketHealthPass } from "./marketHealth.js";

dotenv.config();

async function main() {
  // Example token address on BSC (replace with any token you want to test)
  const tokenAddress = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD token

  console.log(`🧪 Testing market health for token: ${tokenAddress}`);
  
  try {
    const result = await marketHealthPass(tokenAddress);
    console.log("✅ Market health pass:", result);
  } catch (err) {
    console.error("❌ Error during market health check:", err);
  }
}

main();