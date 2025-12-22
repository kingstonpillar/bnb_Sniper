// testScanedPrice.js
import dotenv from "dotenv";
import fs from "fs";
import { scanedPrice } from "./scanedPrice.js";

dotenv.config();

/* ================= PRE-CHECK ================= */
const JSON_FILE = "./potential_migrators.json";

if (!fs.existsSync(JSON_FILE)) {
  console.error("❌ potential_migrators.json not found");
  process.exit(1);
}

const migrators = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
if (!migrators.length) {
  console.error("❌ No tokens found in potential_migrators.json");
  process.exit(1);
}

const testToken = migrators[0].tokenmint;

console.log("🧪 Testing scanedPrice.js");
console.log("Token:", testToken);

/* ================= RUN TEST ================= */
(async () => {
  try {
    const result = await scanedPrice(testToken);

    if (!result) {
      console.error("❌ scanedPrice returned null");
      process.exit(1);
    }

    console.log("\n✅ scanedPrice SUCCESS\n");
    console.table({
      priceBNB: result.priceBNB,
      priceUSD: result.priceUSD,
      liquidityBNB: result.liquidityBNB,
      marketCapBNB: result.marketCap,
      bnbReserve: result.bnbReserve
    });

    console.log("\n🟢 Test completed successfully");
    process.exit(0);

  } catch (err) {
    console.error("❌ Test failed:", err.message);
    process.exit(1);
  }
})();