import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js";

const TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

const TEST_WALLET = "0x0000000000000000000000000000000000000000"; // safe dummy wallet
const FACTORY = process.env.PANCAKE_FACTORY;
const ROUTER = process.env.PANCAKE_ROUTER;

(async () => {
  for (const token of TOKENS) {
    try {
      const result = await walletRate(token, ROUTER, TEST_WALLET, FACTORY);
      console.log(result);
    } catch (err) {
      console.error(`Error testing token ${token}:`, err.message);
    }
  }
})();