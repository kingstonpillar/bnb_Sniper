import { executeAutoSell } from "./autosellToken.js";
import { MockProvider, MockWallet, MockContract } from "./ethermock.js";
import * as ethers from "ethers";

ethers.JsonRpcProvider = MockProvider;
ethers.Wallet = class { constructor() { return new MockWallet(); } };
ethers.Contract = MockContract;

process.env.ENCRYPTED_KEY = "mock";
process.env.KEY_PASSPHRASE_FILE = "./test/pass.txt";
process.env.RPC_URL_1 = "mock";

(async () => {
  const tx = await executeAutoSell("0xMockToken");
  console.log("✅ OFFLINE AUTO-SELL TEST PASSED, tx:", tx);
})();