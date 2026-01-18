// file: testscanedPrice.js
// Run: node testscanedPrice.js

import { scanedPrice } from "./scanedPrice.js";

const TESTS = [
  {
    token: "0xF9c6E80E9A5807a1214A79449009B48104F94444",
    pair:  "0x298c4A3eE26f0E9151175A4F4354EA09EEaE7628"
  },
  // Add the correct pair for 0x6E6b... here when you have it
  // {
  //   token: "0x6E6b5A02579ca1Fd9e17c5f7908c59A9bA543017",
  //   pair:  "0xYourCorrectPairHere"
  // }
];

(async () => {
  for (const t of TESTS) {
    console.log("\nTesting scanedPrice.js");
    console.log("Token:", t.token);
    console.log("Pair :", t.pair);
    console.log("");

    const r = await scanedPrice(t.token, t.pair, { full: true, debug: true });

    if (!r) {
      console.log("scanedPrice returned null/failed.");
      continue;
    }

    console.log("SUCCESS");
    console.table({
      token: r.token,
      pair: r.pair,
      priceBNB: r.priceBNB,
      priceUSD: r.priceUSD,
      liquidityBNB: r.liquidityBNB,
      liquidityUSD: r.liquidityUSD,
      marketCapBNB: r.marketCapBNB,
      totalSupply: r.totalSupply
    });
  }
})();