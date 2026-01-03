// testWalletRate.js
import dotenv from 'dotenv';
dotenv.config();

import { walletRate } from "./walletHistory.js"; // your main logic file

// Tokens to test
const tokens = [
  { name: "SAFU", address: "0x3f2b10f3327ea2337c524eef23f4cd61bc364444" },
  { name: "Salamanca", address: "0x42fE1937E1db4F11509e9f7FdD97048BD8d04444" }
];

async function runTests() {
  const WBNB = process.env.WBNB_ADDRESS;
  const PANCAKE_FACTORY = process.env.PANCAKE_FACTORY;

  if (!WBNB || !PANCAKE_FACTORY) {
    console.error("Please set WBNB_ADDRESS and PANCAKE_FACTORY in your .env file");
    process.exit(1);
  }

  console.log("=== Starting Wallet Rate Tests ===\n");

  for (const token of tokens) {
    console.log(`--- Testing ${token.name} (${token.address}) ---`);
    try {
      const result = await walletRate(token.address, WBNB, PANCAKE_FACTORY);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error testing ${token.name}:`, err.message);
    }
  }

  console.log("\n=== Wallet Rate Tests Completed ===");
}

runTests();