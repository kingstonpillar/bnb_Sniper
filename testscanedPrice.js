// file: testscanedPrice.js
// Run: node testscanedPrice.js
// Or:  node testscanedPrice.js 0xTokenAddress

import fs from "fs";
import { scanedPrice } from "./scanedPrice.js";

const JSON_FILE = "./potential_migrators.json";

function pickTokenFromJson() {
  if (!fs.existsSync(JSON_FILE)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0]?.tokenmint || null;
  } catch {
    return null;
  }
}

(async () => {
  const token = (process.argv[2] || pickTokenFromJson() || "").trim();

  if (!token) {
    console.error("No token provided and potential_migrators.json is empty/missing.");
    process.exit(1);
  }

  console.log("Testing scanedPrice.js");
  console.log("Token:", token);
  console.log("");

  try {
    // IMPORTANT: request full object
    const result = await scanedPrice(token, null, { full: true });

    if (!result || result.ok !== true) {
      console.error("scanedPrice returned null/failed.");
      process.exit(1);
    }

    console.log("SUCCESS");
    console.table({
      token: result.token,
      pair: result.pair,
      priceBNB: result.priceBNB,
      priceUSD: result.priceUSD,
      liquidityBNB: result.liquidityBNB,
      liquidityUSD: result.liquidityUSD,
      tokenReserve: result.reserves?.token,
      wbnbReserve: result.reserves?.wbnb,
      marketCapBNB: result.marketCapBNB
    });

    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err?.message || err);
    process.exit(1);
  }
})();