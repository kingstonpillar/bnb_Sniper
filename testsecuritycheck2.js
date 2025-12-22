// file: testSecurityCheck.js
import { securitySafety } from "./securitycheck2.js"; // your file

import { ethers } from "ethers";

async function main() {
  const testToken = "0x0000000000000000000000000000000000000000"; // mock token

  // ----- MOCK ethers.Contract -----
  const originalContract = ethers.Contract;
  ethers.Contract = function (address, abi, provider) {
    return {
      totalSupply: async () => 1000n,
      balanceOf: async (addr) => 50n,
      owner: async () => "0x0000000000000000000000000000000000000000",
      transfer: async (to, amount) => true,
      transferFrom: async (from, to, amount) => true,
    };
  };

  // ----- MOCK provider.getCode -----
  const originalProvider = ethers.JsonRpcProvider;
  ethers.JsonRpcProvider = function () {
    return {
      getCode: async (addr) => "0x60003560005560006000", // dummy bytecode
    };
  };

  // ----- MOCK bytecodeHashSimilarityCheck -----
  globalThis.bytecodeHashSimilarityCheck = async () => 20;

  try {
    const result = await securitySafety(testToken);
    console.log("✅ SecuritySafety result (mocked):", result);
  } catch (err) {
    console.error("❌ Error during testSecuritySafety:", err);
  } finally {
    // Restore originals
    ethers.Contract = originalContract;
    ethers.JsonRpcProvider = originalProvider;
  }
}

main();