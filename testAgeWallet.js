import dotenv from "dotenv";
dotenv.config();

import { walletRate, markRug } from "./walletHistory.js"; // your module

// Test tokens
const TEST_TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

// PancakeSwap addresses from .env
const FACTORY_ADDRESS = process.env.PANCAKE_FACTORY;
const ROUTER_ADDRESS = process.env.PANCAKESWAP_ROUTER; 
const TEST_WALLET = "0x0000000000000000000000000000000000000000"; // simulate sell

if (!FACTORY_ADDRESS || !ROUTER_ADDRESS) {
  throw new Error("Please set PANCAKE_FACTORY and PANCAKESWAP_ROUTER in .env");
}

async function testAllTokens() {
  for (const token of TEST_TOKENS) {
    try {
      console.log(`\n=== Testing token: ${token} ===`);
      const result = await walletRate(token, ROUTER_ADDRESS, TEST_WALLET, FACTORY_ADDRESS);
      console.table(result);

      const dev = result[0].dev;
      console.log(`Marking rug for dev: ${dev}`);
      markRug(dev);
    } catch (e) {
      console.error("Error testing token:", token, e.message || e);
    }
  }
}

// Run the test
testAllTokens();