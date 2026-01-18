// file: test_liquidityLock.js
// Run:
//   node test_liquidityLock.js

import { liquidityLock } from "./liquidityCheck.js";

/**
 * Hardcoded test tokens only
 * No .env
 * No process.env
 */
const TEST_TOKENS = [
  "0x31927a3d243b06e823407763f6940c62c4679ee5",
  "0x6E6b5A02579ca1Fd9e17c5f7908c59A9bA543017"
];

function pct(x) {
  if (!Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(2)}%`;
}

function secsToDays(s) {
  if (!Number.isFinite(s) || s <= 0) return "n/a";
  return `${(s / 86400).toFixed(2)} days`;
}

async function runTest(token) {
  console.log("========================================");
  console.log("Testing liquidityLock");
  console.log("Token:", token);
  console.log("");

  try {
    const result = await liquidityLock(token);

    console.log("=== SUMMARY ===");
    console.log("ok:", Boolean(result?.ok));
    console.log("pass:", Boolean(result?.pass));
    console.log("finalOk:", Boolean(result?.finalOk));
    console.log("reason:", result?.reason || null);
    console.log("pairAddress:", result?.pairAddress || null);

    console.log("");
    console.log("=== METRICS ===");
    console.log("locked:", Boolean(result?.locked));
    console.log("burnedPct:", pct(Number(result?.burnedPct)));
    console.log("lockedPct:", pct(Number(result?.lockedPct)));
    console.log("totalSupply:", result?.totalSupply || "0");
    console.log("burned:", result?.burned || "0");
    console.log("lockedAmount:", result?.lockedAmount || "0");

    console.log("");
    console.log("=== DURATION GATE (GoPlus) ===");
    const dg = result?.durationGate || {};
    console.log("enabled:", Boolean(dg?.enabled));
    console.log("ok:", Boolean(dg?.ok));
    console.log("hasDuration:", Boolean(dg?.hasDuration));
    console.log("matchedKnownLocker:", Boolean(dg?.matchedKnownLocker));
    console.log(
      "maxLockDuration:",
      Number(dg?.maxLockDuration || 0),
      `(${secsToDays(Number(dg?.maxLockDuration || 0))})`
    );
    console.log(
      "minLockSeconds:",
      Number(dg?.minLockSeconds || 0),
      `(${secsToDays(Number(dg?.minLockSeconds || 0))})`
    );
    console.log("matchedLockers:", Array.isArray(dg?.matchedLockers) ? dg.matchedLockers : []);

    console.log("");
    console.log("=== RAW RESULT ===");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Test failed:", err?.message || err);
  }

  console.log("");
}

(async () => {
  for (const token of TEST_TOKENS) {
    await runTest(token);
  }
})();