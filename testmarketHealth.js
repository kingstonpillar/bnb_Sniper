import { marketHealthPass } from "./marketHealth.js";

const pairAddress = "0xAA72FD8A0ADb6903b35C29A8D50655d05C3fF253";

(async () => {
  try {
    const healthy = await marketHealthPass(pairAddress);
    console.log("Market health:", healthy ? "✅ Healthy" : "❌ Unhealthy");
  } catch (err) {
    console.error("Error checking market health:", err.message);
  }
})();