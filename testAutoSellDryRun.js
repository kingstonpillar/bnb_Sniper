import dotenv from "dotenv";
dotenv.config();

import { executeAutoSell } from "./autoSellToken.js";

async function main() {
  const token = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD
  console.log("Testing executeAutoSell DRY RUN (no broadcast)");
  console.log("Token:", token);

  const res = await executeAutoSell(token, { dryRun: true });
  console.log("Result:", res);
}

main().catch((e) => console.error("Error:", e));