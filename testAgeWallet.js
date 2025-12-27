import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js";

/* ================= TOKENS TO TEST ================= */

const TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
].map(t => t.toLowerCase());

/* ================= RUN TEST ================= */

async function run() {
  console.log("🚀 Starting walletRate tests...\n");

  for (const token of TOKENS) {
    try {
      console.log("🔎 Token:", token);

      // 👇 IMPORTANT: only token is passed
      // sell simulation uses DEV wallet internally
      const result = await walletRate(token);

      console.dir(result, { depth: null });
      console.log("--------------------------------------------------\n");
    } catch (err) {
      console.error("❌ Error testing token:", token);
      console.error(err.message);
      console.log("--------------------------------------------------\n");
    }
  }

  process.exit(0);
}

run();