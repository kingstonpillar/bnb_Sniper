// projectContracts.js
import { ethers } from "ethers";

/*
   UNIVERSAL PROJECT CONTRACT DETECTOR
   -----------------------------------
   Marks ONLY real project-level contracts as TRUE:

   - Routers
   - Factories
   - Launchpads
   - Staking / MasterChef
   - Bridges
   - Modules
   - Upgradeable proxy contracts (ALWAYS return TRUE)
   - ANY non-BEP20 logic contract

   Normal BEP20 tokens return FALSE = SAFE TOKEN
*/

export async function isProjectContract(address, provider) {
  if (!provider) throw new Error("Provider required");

  const code = await provider.getCode(address);
  if (!code || code === "0x") return false; // not even contract
  const hex = code.toLowerCase();

  // ---------------------------------------------------------
  // 1️⃣ PROXY DETECTION (reject)
  // ---------------------------------------------------------
  const proxySelectors = [
    "3659cfe6", // implementation()
    "5c60da1b", // proxyAdmin()
    "52d1902d", // upgradeTo
    "4f1ef286"  // upgradeToAndCall
  ];

  if (proxySelectors.some(x => hex.includes(x))) {
    return true; // identified as project-level
  }

  // EIP1967 implementation slot
  const IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076";

  try {
    const storage = await provider.getStorageAt(address, IMPLEMENTATION_SLOT);
    const impl = "0x" + storage.slice(-40);
    if (impl !== "0x0000000000000000000000000000000000000000") {
      return true; // proxy → project contract
    }
  } catch {}

  // ---------------------------------------------------------
  // 2️⃣ ROUTER / FACTORY / LP BYTECODE SELECTORS (hex only)
  // ---------------------------------------------------------
  const projectSelectors = [
    // swap functions
    "38ed1739", // swapExactTokensForTokens
    "18cbafe5", // swapExactTokensForETH
    "8803dbee", // swapTokensForExactTokens
    "5c11d795", // swapExactETHForTokens
    "fb3bdb41", // swapETHForExactTokens

    // factory
    "c9c65396", // createPair
    "0dfe1681", // token0()
    "d21220a7", // token1()

    // LP / reserve
    "0902f1ac", // getReserves

    // launchpad / liquidity
    "e8e33700", // addLiquidity
    "715018a6", // addLiquidityETH
    "8f4ffcb1", // migrate

    // farming / staking
    "3d18b912", // deposit
    "441a3e70", // withdraw
    "e2bbb158", // harvest

    // bridges / modules
    "79cc6790", // send
    "ed98f5af"  // relay
  ];

  if (projectSelectors.some(sig => hex.includes(sig))) {
    return true;   // router/factory/masterchef/etc
  }

  // ---------------------------------------------------------
  // 3️⃣ NON-BEP20 CONTRACTS LARGER THAN A TOKEN
  // (BEP20 bytecode is small, routers/factories are huge)
  // ---------------------------------------------------------
  if (hex.length > 20000) {
    return true;  // definitely router/factory/module
  }

  // ---------------------------------------------------------
  // 4️⃣ SAFE → Normal BEP20 token (NOT project-level)
  // ---------------------------------------------------------
  return false;
}