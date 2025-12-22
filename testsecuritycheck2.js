// file: testSecurityPerfect.js
import { securityPerfect } from "./securityPerfect.js"; // your function
import dotenv from "dotenv";
dotenv.config();

async function main() {
  // Mock token address
  const testToken = "0xe9e7cea3dedca5984780bafc599bd69add087d56";

  // Create a mock contract to simulate ethers.Contract
  const mockContract = {
    totalSupply: async () => 1000000n,  // 1,000,000 tokens
    decimals: async () => 18,           // standard ERC20 decimals
    symbol: async () => "MOCK",
    name: async () => "Mock Token"
  };

  try {
    const result = await securityPerfect(testToken, mockContract);
    console.log("✅ securityPerfect result (mocked):", result);
  } catch (err) {
    console.error("❌ Error during testSecurityPerfect:", err);
  }
}

main();