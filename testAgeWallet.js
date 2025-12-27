import dotenv from "dotenv";
dotenv.config();

import { walletRate } from "./walletHistory.js"; // Make sure path is correct

/* ===================== HELPERS ===================== */
function normalizeAddress(addr) {
  if (!addr) throw new Error("Empty address");
  addr = addr.toString().trim();
  if (!addr.startsWith("0x")) {
    throw new Error(`Invalid address (missing 0x): ${addr}`);
  }
  return addr.toLowerCase();
}

/* ===================== CONFIG ===================== */
const TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

const PANCAKE_ROUTER = normalizeAddress(process.env.PANCAKE_ROUTER);
const PANCAKE_FACTORY = normalizeAddress(process.env.PANCAKE_FACTORY);

// Dummy wallet for testing (does NOT need real funds)
const TEST_WALLET = normalizeAddress(process.env.WALLET_ADDRESS || "0x0000000000000000000000000000000000000001");

/* ===================== RUN TEST ===================== */
(async () => {
  for (const token of TOKENS) {
    const tokenAddr = normalizeAddress(token);
    try {
      const result = await walletRate(tokenAddr, PANCAKE_ROUTER, TEST_WALLET, PANCAKE_FACTORY);
      console.log("✅ Token Test Result:", JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`❌ Error testing token ${tokenAddr}:`, err.message);
    }
  }
})();