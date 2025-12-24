import { executeAutoSell } from "./autosellToken.js";

process.env.RPC_URL_1 = process.env.RPC_URL_1; // real RPC already in env
process.env.ENCRYPTED_KEY = process.env.ENCRYPTED_KEY;
process.env.KEY_PASSPHRASE_FILE = "./test/pass.txt";

(async () => {
  try {
    const tx = await executeAutoSell(
      "0x55d398326f99059fF775485246999027B3197955"
    );
    console.log("DRY RUN RESULT:", tx);
  } catch (e) {
    console.error("❌ ERROR:", e.message);
  }
})();