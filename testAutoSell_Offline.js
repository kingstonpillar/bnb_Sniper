// test/autoSell.offline.test.js
import assert from "assert";
import * as autoSell from "../autoSellToken.js";

import { MockProvider, MockWallet, MockContract } from "./mocks/ethersMock.js";

// override ethers globally
import * as ethers from "ethers";

ethers.JsonRpcProvider = MockProvider;
ethers.Wallet = class {
  constructor() { return new MockWallet(); }
};
ethers.Contract = MockContract;

process.env.ENCRYPTED_KEY = "mock";
process.env.KEY_PASSPHRASE_FILE = "./test/pass.txt";
process.env.RPC_URL_1 = "mock";

(async () => {
  const tx = await autoSell.executeAutoSell("0xMockToken");

  assert.equal(tx, "0xMOCK_TX_HASH");
  console.log("✅ OFFLINE AUTO-SELL TEST PASSED");
})();