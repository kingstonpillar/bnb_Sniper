import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js"; // your scanner function

// Tokens you want to test
const tokens = [
  { name: "SAFU", address: "0x3f2B10F3327ea2337C524eEf23F4cd61bC364444" },
  { name: "Salamanca", address: "0x42fE1937E1db4F11509e9f7FdD97048BD8d04444" },
  { name: "WBNB", address: process.env.WBNB_ADDRESS }
];

async function runTests() {
  for (const token of tokens) {
    console.log(`\n--- Testing ${token.name} (${token.address}) ---`);
    try {
      // Only pass token address; everything else is handled internally
      const result = await walletRate(token.address);

      // Show scanner results only
      console.log("Final Wallet Rate Result:");
      console.log({
        token: result.token,           // original token mint
        totalScore: result.totalScore,
        health: result.health,
        antiSell: result.details.antiSell,
        taxCheck: result.details.taxCheck
      });
    } catch (err) {
      console.error(`Error testing ${token.name}:`, err.message);
    }
  }
}

runTests();