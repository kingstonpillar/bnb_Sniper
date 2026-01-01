import dotenv from 'dotenv';
dotenv.config();

import { walletRate } from "./walletHistory.js"; // import from your main script

// Meme tokens to test
const tokens = [
  { name: "SAFU", address: "0x3f2b10f3327ea2337c524eef23f4cd61bc364444" },
  { name: "Salamanca", address: "0x42fE1937E1db4F11509e9f7FdD97048BD8d04444" }
];

async function runTests() {
  for (const token of tokens) {
    console.log(`\n=== Testing ${token.name} (${token.address}) ===`);
    try {
      const result = await walletRate(token.address);
      console.log("Final Wallet Rate Result:", JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error testing ${token.name}:`, err.message);
    }
  }
}

runTests();