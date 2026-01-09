import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";

const PROJECT_RPC = process.env.PROJECT_RPC || "https://bsc-dataseed1.binance.org/";
const provider = new ethers.JsonRpcProvider(PROJECT_RPC);

// PQueue for rate-limiting RPC calls
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 2 });

export async function isProjectContract(address) {
  if (!address) throw new Error("No address provided");

  return rpcQueue.add(async () => {
    const code = await provider.getCode(address);
    if (!code || code === "0x") return false;

    const hex = code.toLowerCase();

    // --- 1️⃣ PROXY DETECTION ---
    const proxySelectors = [
      "3659cfe6", "5c60da1b", "52d1902d", "4f1ef286"
    ];
    if (proxySelectors.some(x => hex.includes(x))) return true;

    const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076";
    try {
      const storage = await provider.getStorageAt(address, IMPLEMENTATION_SLOT);
      const impl = "0x" + storage.slice(-40);
      if (impl !== "0x0000000000000000000000000000000000000000") return true;
    } catch {}

    // --- 2️⃣ ROUTER / FACTORY SELECTORS ---
    const projectSelectors = [
      "38ed1739","18cbafe5","8803dbee","5c11d795","fb3bdb41",
      "c9c65396","0dfe1681","d21220a7","0902f1ac","e8e33700",
      "715018a6","8f4ffcb1","3d18b912","441a3e70","e2bbb158",
      "79cc6790","ed98f5af"
    ];
    if (projectSelectors.some(sig => hex.includes(sig))) return true;

    // --- 3️⃣ LARGE CONTRACT BYTECODE ---
    if (hex.length > 20000) return true;

    // --- 4️⃣ OTHERWISE NORMAL BEP20 ---
    return false;
  });
}