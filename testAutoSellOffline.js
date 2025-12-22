// file: testAutoSellOffline.js
import { executeAutoSell } from "./autoSellToken.js";
import { markSellStart, markSellComplete } from "./sellmonitor.js";
import { ethers } from "ethers";

// -------------------- MOCKS --------------------

// Mock RPC provider
jest.mock("ethers", () => {
  const original = jest.requireActual("ethers");
  const BigNumber = original.BigNumber;
  class MockProvider {
    constructor() {}
  }
  class MockWallet {
    constructor() {
      this.address = "0xMockWalletAddress";
    }
  }
  class MockContract {
    constructor(address, abi, signerOrProvider) {
      this.address = address;
      this.abi = abi;
      this.signer = signerOrProvider;
    }
    async balanceOf() {
      return 1000n; // mock 1000 tokens
    }
    async allowance() {
      return 0n; // no allowance yet
    }
    async approve() {
      return { wait: async () => null };
    }
  }
  class MockRouter {
    constructor() {}
    async getAmountsOut(amount, path) {
      return [amount, 900n]; // mock amount out
    }
    async swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline, opts) {
      return { hash: "0xMOCKTX", wait: async () => null };
    }
  }

  return {
    ...original,
    Wallet: MockWallet,
    Contract: MockContract,
    JsonRpcProvider: MockProvider,
  };
});

// Mock Telegram
jest.mock("node-fetch", () => async () => ({ ok: true }));

// Mock sellmonitor functions
jest.mock("./sellmonitor.js", () => ({
  markSellStart: async () => console.log("markSellStart called"),
  markSellComplete: async () => console.log("markSellComplete called"),
  allSellsComplete: async () => true,
}));

// -------------------- TEST --------------------
(async () => {
  try {
    const txHash = await executeAutoSell("0xMockTokenAddress");
    console.log("Offline test completed, txHash:", txHash);
  } catch (err) {
    console.error("Offline test failed:", err);
  }
})();