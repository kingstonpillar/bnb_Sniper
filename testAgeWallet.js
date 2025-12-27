import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js"; // your module

// ✅ Tokens to test
const TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

// Dummy test wallet (no funds required, safe)
const TEST_WALLET = "0x0000000000000000000000000000000000000001";

const PANCAKE_FACTORY = process.env.PANCAKE_FACTORY;
const PANCAKE_ROUTER = process.env.PANCAKE_ROUTER;

if (!PANCAKE_FACTORY || !PANCAKE_ROUTER) {
  throw new Error("Please set PANCAKE_FACTORY and PANCAKE_ROUTER in .env");
}

async function main() {
  for (const token of TOKENS) {
    try {
      const results = await walletRate(
        token,
        PANCAKE_ROUTER,
        TEST_WALLET,
        PANCAKE_FACTORY
      );

      console.log(`\nResults for token: ${token}`);
      console.log(JSON.stringify(results, null, 2));
    } catch (err) {
      console.error(`Error testing token ${token}:`, err.message);
    }
  }
}

main();