import { autoBuyToken } from "./swapExecutor.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const testToken = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD for testing
  console.log(`🧪 Testing autoBuyToken (offline) with token: ${testToken}`);

  // Local mock (avoid overwriting read-only ethers)
  const mockContract = () => ({
    getAmountsOut: async (amountIn, path) => [amountIn, amountIn],
    swapExactETHForTokens: async (amountOutMin, path, to, deadline, opts) => ({
      hash: "0xMOCK_TX_HASH",
      wait: async () => true
    }),
    totalSupply: async () => BigInt("1000000000000000000000"),
    getPair: async () => "0xMOCK_PAIR_ADDRESS"
  });

  try {
    const result = await autoBuyToken(testToken, mockContract);
    console.log("✅ AutoBuyToken result (mocked):", result);
  } catch (err) {
    console.error("❌ Error during test autoBuyToken:", err);
  }
}

main();