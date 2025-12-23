import { autoBuyToken } from "./swapExecutor.js";
import dotenv from "dotenv";

dotenv.config();

// Set offline mode
const OFFLINE = true;

async function main() {
  const testToken = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // Example: BUSD token
  const testPair = "0x..."; // Replace with pair address if needed

  console.log(`🧪 Testing autoBuyToken in OFFLINE mode: ${OFFLINE}`);

  // Mock the pairAddress if offline mode expects a function instead of real contract
  const pairInput = OFFLINE ? () => {} : testPair;

  const result = await autoBuyToken(testToken, pairInput);

  console.log(`✅ AutoBuyToken result (mocked/offline):`, result);
}

main().catch(console.error);