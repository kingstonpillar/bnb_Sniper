import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js"; // your main walletRate function

const tokens = [
  { name: "SAFU", address: "0x3f2B10F3327ea2337C524eEf23F4cd61bC364444" },
  { name: "Salamanca", address: "0x42fE1937E1db4F11509e9f7FdD97048BD8d04444" },
  { name: "WBNB", address: process.env.WBNB_ADDRESS }
];

async function runTests() {
  for (const token of tokens) {
    console.log(`\n--- Testing ${token.name} (${token.address}) ---`);
    try {
      const result = await walletRate(token.address, process.env.WBNB_ADDRESS, process.env.PANCAKE_FACTORY);
      console.log("Final Wallet Rate Result:", JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error testing ${token.name}:`, err.message);
    }
  }
}

runTests();