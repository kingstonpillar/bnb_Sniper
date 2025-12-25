// testWalletRate.js
import { walletRate } from "./yourModule.js"; // adjust path if needed

const testToken = "0xca9deb6ff27a3b86905a8bf70c613a1bc6d89cc2";

async function runTest() {
  try {
    console.log(`\nChecking wallet health for token: ${testToken}\n`);
    const result = await walletRate(testToken);
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Test failed:", err.message || err);
  }
}

runTest();