// testLockDuration.js
// Usage:
//   node testLockDuration.js
//
// Requires:
//   - lockDuration.js in same folder
//   - .env contains BSC_RPC

import "dotenv/config";
import { lockDuration, isLockAtLeastDays } from "./lockDuration.js";

const PAIR_OR_LP = "0x31927a3d243b06e823407763f6940c62c4679ee5";

async function main() {
  const r = await lockDuration(PAIR_OR_LP, {
    // Increase this if your RPC struggles with full history scans.
    // If you know roughly when it was locked, set fromBlock near that time.
    fromBlock: 0
  });

  console.log("=== LOCK DURATION RESULT ===");
  console.log(JSON.stringify(r, null, 2));

  const locked90 = isLockAtLeastDays(r, 90);
  console.log("\n=== 90-DAY CHECK ===");
  console.log("locked:", r.locked);
  console.log("lockDurationDays:", Number(r.lockDurationDays || 0));
  console.log(">= 90 days:", locked90);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || String(e));
  process.exit(1);
});