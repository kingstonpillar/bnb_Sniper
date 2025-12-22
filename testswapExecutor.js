// file: testSwapExecutorOffline.js
import { autoBuyToken } from "./swapExecutor.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const testToken = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD for testing

  console.log(`🧪 Testing autoBuyToken (offline) with token: ${testToken}`);

  // Mock router contract methods
  globalThis.ethers = globalThis.ethers || {};
  const originalContract = globalThis.ethers.Contract;

  globalThis.ethers.Contract = function (address, abi, walletOrProvider) {
    return {
      getAmountsOut: async (amountIn, path) => {
        console.log("💡 Mock getAmountsOut called with:", { amountIn: amountIn.toString(), path });
        // Simulate a 1:1 swap for simplicity
        return [amountIn, amountIn];
      },
      swapExactETHForTokens: async (amountOutMin, path, to, deadline, opts) => {
        console.log("💡 Mock swapExactETHForTokens called:", { amountOutMin: amountOutMin.toString(), path, to, deadline, opts });
        return {
          hash: "0xMOCK_TX_HASH",
          wait: async () => true
        };
      },
      totalSupply: async () => BigInt("1000000000000000000000"), // 1k tokens for test
      getPair: async () => "0xMOCK_PAIR_ADDRESS"
    };
  };

  try {
    const result = await autoBuyToken(testToken);
    console.log("✅ AutoBuyToken result (mocked):", result);
  } catch (err) {
    console.error("❌ Error during test autoBuyToken:", err);
  } finally {
    // Restore original ethers.Contract
    globalThis.ethers.Contract = originalContract;
  }
}

main();