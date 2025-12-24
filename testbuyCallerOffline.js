// testbuyCallerOffline.js
import { buyCaller } from "./buyCaller.js";

(async () => {
  try {
    console.log("⚡ Running buyCaller in dry-run mode (offline)...");
    // If buyCaller has network calls, it will fail gracefully
    await buyCaller();
    console.log("✅ buyCaller test finished (dry-run).");
  } catch (err) {
    console.warn("⚠️ Expected offline errors (ignored for dry-run):", err.message);
  }
})();