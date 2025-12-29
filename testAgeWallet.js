// testTokens.js
import { walletRate } from "./walletHistory.js"; // import from your main script

const tokens = [
  { name: "TEST_TOKEN", address: "0xc748673057861a797275cd8a068abb95a902e8de" },
  { name: "CAKE (CONTROL)", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" }
];

async function testTokens() {
  for (const t of tokens) {
    console.log(`\n======================================`);
    console.log(`🔍 Testing: ${t.name}`);
    console.log(`📌 Address: ${t.address}`);
    console.log(`======================================`);

    try {
      const result = await walletRate(t.address);
      console.log(result);
    } catch (err) {
      console.error("❌ Error testing token:", err.message);
    }
  }
}

testTokens();