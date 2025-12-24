import { executeAutoSell } from "./autosellToken.js";

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