import fs from "fs";
import * as ethers from "ethers";
import { buyCaller } from "./buyCaller.js";

// -------------------- MOCKS --------------------
class MockProvider {}
class MockWallet {
  constructor() { this.address = "0xMOCK_WALLET"; }
}
class MockContract {
  constructor(address, abi, walletOrProvider) {
    this.address = address;
    this.abi = abi;
    this.walletOrProvider = walletOrProvider;
  }
  async balanceOf() { return 1000n; }
  async allowance() { return 1000n; }
  async approve() { return { wait: async () => {} }; }
  async getAmountsOut(amountIn, path) { return [amountIn, amountIn]; }
  async swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline, options) {
    return { hash: "0xMOCK_TX_HASH", wait: async () => {} };
  }
}

// -------------------- OVERRIDE GLOBALS --------------------
ethers.JsonRpcProvider = MockProvider;
ethers.Wallet = MockWallet;
ethers.Contract = MockContract;

// -------------------- MOCK ENV --------------------
process.env.ENCRYPTED_KEY = "MOCK";
process.env.KEY_PASSPHRASE_FILE = "/dev/null";
process.env.RPC_URL_1 = "mock";

// -------------------- MOCK MIGRATORS --------------------
const POTENTIAL_MIGRATORS = "./potential_migrators.json";
fs.writeFileSync(POTENTIAL_MIGRATORS, JSON.stringify([
  { tokenmint: "0xMOCK_TOKEN1", pairaddress: "0xMOCK_PAIR1" },
  { tokenmint: "0xMOCK_TOKEN2", pairaddress: "0xMOCK_PAIR2" }
], null, 2));

// -------------------- RUN OFFLINE --------------------
(async () => {
  try {
    await buyCaller(); // will run dry-run with mocks

    const remaining = JSON.parse(fs.readFileSync(POTENTIAL_MIGRATORS, "utf8"));
    console.log("✅ Offline buyCaller test complete.");
    console.log("Remaining tokens in migrators file:", remaining);
  } catch (err) {
    console.error("❌ Offline test failed:", err);
  }
})();