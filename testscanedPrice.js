// file: testscanedPrice.js
// Run:
//   node testscanedPrice.js
//   node testscanedPrice.js 0xTokenAddress 0xPairAddress
//
// Hardcoded default test values (no JSON, no .env required for token/pair):
// Token: 0x6E6b5A02579ca1Fd9e17c5f7908c59A9bA543017
// Pair : 0x298c4A3eE26f0E9151175A4F4354EA09EEaE7628

import { scanedPrice } from "./scanedPrice.js";

const DEFAULT_TOKEN = "0x6E6b5A02579ca1Fd9e17c5f7908c59A9bA543017";
const DEFAULT_PAIR  = "0x298c4A3eE26f0E9151175A4F4354EA09EEaE7628";

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  const token = String(process.argv[2] || DEFAULT_TOKEN).trim();
  const pair  = String(process.argv[3] || DEFAULT_PAIR).trim();

  console.log("Testing scanedPrice.js (no JSON)");
  console.log("Token:", token);
  console.log("Pair :", pair);
  console.log("");

  try {
    // IMPORTANT: request full object, and pass pair override
    const result = await scanedPrice(token, pair, { full: true, debug: true });

    if (!result || result.ok !== true) {
      console.error("scanedPrice returned null/failed.");
      process.exit(1);
    }

    console.log("SUCCESS");
    console.table({
      token: result.token,
      pair: result.pair,
      priceBNB: num(result.priceBNB),
      priceUSD: num(result.priceUSD),
      liquidityBNB: num(result.liquidityBNB),
      liquidityUSD: num(result.liquidityUSD),
      tokenReserve: num(result.reserves?.token),
      wbnbReserve: num(result.reserves?.wbnb),
      marketCapBNB: num(result.marketCapBNB),
      totalSupply: num(result.totalSupply),
      tokenDecimals: num(result.tokenDecimals)
    });

    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err?.message || err);
    process.exit(1);
  }
})();