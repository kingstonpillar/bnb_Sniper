import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import { walletRate } from "./walletHistory.js";

/* ================= SETUP ================= */
const web3 = new Web3(process.env.RPC_URL_8);

const PANCAKE_FACTORY = process.env.PANCAKE_FACTORY;
const WBNB = process.env.WBNB_ADDRESS;

/* ================= ABIs ================= */
const FACTORY_ABI = [
  {
    "constant": true,
    "inputs": [
      { "name": "tokenA", "type": "address" },
      { "name": "tokenB", "type": "address" }
    ],
    "name": "getPair",
    "outputs": [{ "name": "pair", "type": "address" }],
    "type": "function"
  }
];

const ERC20_ABI = [
  {
    "constant": true,
    "inputs": [{ "name": "owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "", "type": "uint256" }],
    "type": "function"
  }
];

/* ================= TEST TOKENS ================= */
const TOKENS = [
  "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253",
  "0x595b0774d1b2c87dbf9720912ba0870ae9b94444"
];

const ROUTER = process.env.PANCAKE_ROUTER;
const TEST_WALLET = process.env.WALLET_ADDRESS;

/* ================= RUN ================= */
(async () => {
  console.log("Checking dev wallet + LP control...\n");

  const factory = new web3.eth.Contract(FACTORY_ABI, PANCAKE_FACTORY);

  for (const token of TOKENS) {
    try {
      /* -------- Get LP address -------- */
      const lpAddress = await factory.methods
        .getPair(token, WBNB)
        .call();

      if (
        !lpAddress ||
        lpAddress === "0x0000000000000000000000000000000000000000"
      ) {
        console.log(`Token: ${token}`);
        console.log("❌ No LP pair found\n");
        continue;
      }

      /* -------- Create LP contract -------- */
      const lpContract = new web3.eth.Contract(ERC20_ABI, lpAddress);

      /* -------- Call your REAL export -------- */
      const [result] = await walletRate(
        token,
        ROUTER,
        TEST_WALLET,
        lpContract
      );

      console.log(`Token: ${token}`);
      console.log("Dev:", result.dev);
      console.log("LP owned by dev:", result.lpOwned);
      console.log("Sellable:", result.sellable);
      console.log("Score:", result.score);
      console.log("Health:", result.health);
      console.log("-------------------------\n");

    } catch (err) {
      console.error(`Error for token ${token}:`, err.message);
    }
  }
})();