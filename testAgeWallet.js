import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js";

const TEST_TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

(async () => {
  console.log("Checking dev wallet age for tokens...\n");

  for (const token of TEST_TOKENS) {
    try {
      // Only need token, pass router and testWallet as dummy addresses
      const result = await walletRate(token, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000");

      const { dev, walletAgeMinutes, health } = result[0];
      console.log(`Token: ${token}`);
      console.log(`Dev Wallet: ${dev}`);
      console.log(`Wallet Age (minutes): ${walletAgeMinutes}`);
      console.log(`Health: ${health}`);
      console.log("-------------------------\n");

    } catch (err) {
      console.error(`Error for token ${token}:`, err.message);
    }
  }
})();