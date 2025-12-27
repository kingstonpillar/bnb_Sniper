import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js";

const testTokens = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

const router = process.env.PANCAKE_ROUTER;
const factory = process.env.PANCAKE_FACTORY;

(async () => {
  for (const token of testTokens) {
    try {
      const result = await walletRate(token, router, null, factory);
      console.log(result);
    } catch (err) {
      console.error("❌ Error testing token", token, ":", err.message);
    }
  }
})();