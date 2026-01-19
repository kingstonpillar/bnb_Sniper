// file: testAutoBuyOffline.js
import { autoBuyToken } from "./swapExecutor.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const testToken = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD
  const dummyPair = "0x000000000000000000000000000000000000dEaD"; // any valid address

  console.log("Testing autoBuyToken OFFLINE (no swap, decrypt + logs only)");
  console.log("Token:", testToken);
  console.log("Pair :", dummyPair);

  try {
    const result = await autoBuyToken(testToken, dummyPair, { offline: true });
    console.log("AutoBuyToken result (offline):", result);
  } catch (err) {
    console.error("Error during offline autoBuyToken test:", err?.message || err);
  }
}

main();