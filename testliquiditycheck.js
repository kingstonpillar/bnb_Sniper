// testliquiditycheck.js
import dotenv from "dotenv";
dotenv.config();

import { liquidityLock } from "./liquidityCheck.js";

async function test() {
  const tokens = [
    "0xf92a1ea652D1279FC7e02305C6713A22815a25E0",
    "0xb1f113c98C8F3C00e8c51F08a5F453fd86cEf262"
  ];

  for (const token of tokens) {
    const result = await liquidityLock(token);
    console.log(`${token} -> locked=${result.locked}, lockedPct=${(result.lockedPct*100).toFixed(2)}%, maxLockDuration=${(result.maxLockDuration/86400).toFixed(1)} days`);
  }
}

test();