import dotenv from "dotenv";
dotenv.config();

import { securityPerfect } from "./securityPerfect.js";

// Pair you want to test
const PAIR_ADDRESS = "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253";

async function main() {
  console.log(`🔍 Testing securityPerfect for pair: ${PAIR_ADDRESS}`);

  try {
    const result = await securityPerfect(PAIR_ADDRESS);
    console.log(`\n✅ securityPerfect result: ${result}`);
  } catch (err) {
    console.error("❌ Error during securityPerfect check:", err);
  }
}

main();