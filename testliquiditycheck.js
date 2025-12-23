import dotenv from "dotenv";
import { verifyLP } from "./lpVerifier.js";
import { liquidityLock } from "./liquidityCheck.js";

dotenv.config();

async function runTests() {
  const tests = [
    "0x2BB4A57B32FdB71705A009F08B3C6e08CBfEBaE7", // CAKE‑WBNB LP
    "0x5C7F8A570d578ED84E63fdFA7b1eE56A0d4623b1"  // BUSD‑WBNB LP
  ];

  for (const tokenAddress of tests) {
    console.log(`\n📌 Testing token: ${tokenAddress}`);

    try {
      const lpResult = await verifyLP(tokenAddress);
      console.log("verifyLP result:", lpResult);
    } catch (err) {
      console.error("verifyLP error:", err.message);
    }

    try {
      const lockResult = await liquidityLock(tokenAddress);
      console.log("liquidityLock result:", lockResult);
    } catch (err) {
      console.error("liquidityLock error:", err.message);
    }
  }
}

runTests().catch(console.error);