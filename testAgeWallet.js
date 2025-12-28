import { walletRate } from "./walletHistory.js";

async function runTest() {
  const TOKENS = [
    {
      name: "TEST_TOKEN",
      address: "0xc748673057861a797275cd8a068abb95a902e8de"
    },
    {
      name: "CAKE (CONTROL)",
      address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"
    }
  ];

  for (const t of TOKENS) {
    console.log("\n======================================");
    console.log(`🔍 Testing: ${t.name}`);
    console.log(`📌 Address: ${t.address}`);
    console.log("======================================");

    try {
      const result = await walletRate(t.address);
      console.log("✅ RESULT:");
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("❌ ERROR:", err.message || err);
    }
  }

  process.exit(0);
}

runTest();