// file: testVerifyLP.js
import dotenv from "dotenv";
dotenv.config();
import { verifyLP } from "./lpVerifier.js";

async function test() {
  const tokens = [
    "0xf92a1ea652D1279FC7e02305C6713A22815a25E0",
    "0xb1f113c98C8F3C00e8c51F08a5F453fd86cEf262"
  ];

  for (const token of tokens) {
    try {
      const result = await verifyLP(token);
      console.log(`Token ${token} -> ok: ${result.ok}, lockedPct: ${(result.lockedPct*100).toFixed(2)}%, maxLockDuration: ${(result.maxLockDuration/86400).toFixed(1)} days`);
    } catch (err) {
      console.error(`Error checking ${token}:`, err.message);
    }
  }
}

test();