import dotenv from 'dotenv';
dotenv.config();

import { ethers } from "ethers";
import { walletRate } from "./walletHistory.js"; // Your main walletRate function

// Helper to normalize addresses
function normalizeAddress(addr) {
  try {
    return ethers.getAddress(addr.trim());
  } catch {
    return null; // Invalid address
  }
}

// Tokens to test (including lowercase or mixed case)
const tokens = [
  { name: "SAFU", address: "0x3f2b10f3327ea2337c524eef23f4cd61bc364444" }, // lowercase
  { name: "Salamanca", address: "0x42fE1937E1db4F11509e9f7FdD97048BD8d04444" }, // mixed case
  { name: "WBNB", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" } // lowercase mainnet token
];

async function runTests() {
  console.log("=== Starting Wallet Rate Tests ===");

  for (const token of tokens) {
    const normalized = normalizeAddress(token.address);
    if (!normalized) {
      console.log(`\n--- Testing ${token.name} ---`);
      console.log({ token: token.address, totalScore: "0", health: "unhealthy", details: { reason: "INVALID_ADDRESS" } });
      continue;
    }

    console.log(`\n--- Testing ${token.name} (${normalized}) ---`);
    try {
      // Pass normalized address to walletRate
      const result = await walletRate(normalized);
      console.log("Final Wallet Rate Result:", JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error testing ${token.name}:`, err.message);
    }
  }

  console.log("\n=== Wallet Rate Tests Completed ===");
}

runTests();