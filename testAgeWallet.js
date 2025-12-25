// testAgeWallet.js
import { walletRate } from "./walletHistory.js"; // make sure this path is correct

const testTokens = [
  "0xca9deb6ff27a3b86905a8bf70c613a1bc6d89cc2",
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253"
];

async function runTest() {
  try {
    console.log(`\nChecking wallet health for tokens:\n${testTokens.join("\n")}\n`);
    const results = await walletRate(testTokens);
    console.log("Results:", JSON.stringify(results, null, 2));
  } catch (err) {
    console.error("Test failed:", err.message || err);
  }
}

runTest();