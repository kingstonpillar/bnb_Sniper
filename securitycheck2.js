import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { bytecodeHashSimilarityCheck } from "./bytecodeCheck.js";

/* ================= CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_51,
  process.env.RPC_URL_61,
  process.env.RPC_URL_7
].filter(Boolean);

if (RPC_URLS.length < 2) {
  throw new Error("At least 2 RPC URLs required");
}

const queue = new PQueue({
  interval: 3000,
  intervalCap: 4,
  concurrency: 1
});

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
}

/* ================= CONSTANTS ================= */
const WBNB = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";

const BURN_ADDRESSES = [
  ethers.ZeroAddress,
  "0x000000000000000000000000000000000000dEaD"
];

const FACTORY_ABI = [
  "function getPair(address,address) view returns(address)"
];

const PAIR_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)"
];

const ERC20_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function owner() view returns(address)",
  "function transfer(address,uint256) returns(bool)",
  "function transferFrom(address,address,uint256) returns(bool)"
];

/* ================= HELPERS ================= */
async function withRpc(fn) {
  let err;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await queue.add(() => fn(provider));
    } catch (e) {
      err = e;
      rotateRpc();
    }
  }
  throw err;
}

/* ================= CORE CHECKS ================= */

// 1️⃣ LP burn
async function lpBurnScore(token) {
  return withRpc(async (prov) => {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, prov);
    const pair = await factory.getPair(token, WBNB);
    if (pair === ethers.ZeroAddress) return 0;

    const lp = new ethers.Contract(pair, PAIR_ABI, prov);
    const total = Number(ethers.formatUnits(await lp.totalSupply(), 18));
    if (!total) return 0;

    let burned = 0;
    for (const addr of BURN_ADDRESSES) {
      burned += Number(
        ethers.formatUnits(await lp.balanceOf(addr), 18)
      );
    }

    return burned / total >= 0.9 ? 20 : 5;
  });
}

// 2️⃣ Dev wallet
async function devWalletScore(token) {
  return withRpc(async (prov) => {
    const erc = new ethers.Contract(token, ERC20_ABI, prov);
    const supply = Number(await erc.totalSupply());

    let owner;
    try {
      owner = (await erc.owner()).toLowerCase();
    } catch {
      return 5;
    }

    const bal = Number(await erc.balanceOf(owner));
    return bal / supply <= 0.05 ? 10 : 0;
  });
}

// 3️⃣ Ownership
async function ownershipScore(token) {
  return withRpc(async (prov) => {
    try {
      const erc = new ethers.Contract(token, ERC20_ABI, prov);
      const owner = await erc.owner();
      return owner === ethers.ZeroAddress ? 5 : 0;
    } catch {
      return 0;
    }
  });
}

// 4️⃣ Size sanity
async function sizeScore(token) {
  return withRpc(async (prov) => {
    const code = await prov.getCode(token);
    return code.length < 24_000 ? 5 : 0;
  });
}

/* ================= HONEYPOT (FREE RPC SAFE) ================= */

// 5️⃣ Honeypot heuristic
async function honeypotScore(token) {
  return withRpc(async (prov) => {
    const erc = new ethers.Contract(token, ERC20_ABI, prov);
    let score = 0;

    try {
      await erc.transfer(ethers.ZeroAddress, 1n);
      score += 5;
    } catch {
      return 0; // hard revert → strong honeypot signal
    }

    try {
      await erc.transferFrom(ethers.ZeroAddress, ethers.ZeroAddress, 1n);
      score += 5;
    } catch {
      score += 0;
    }

    const code = await prov.getCode(token);
    const badPatterns = [
      "blacklist",
      "cooldown",
      "sellDelay",
      "maxTx",
      "antiBot"
    ];

    for (const p of badPatterns) {
      if (code.toLowerCase().includes(p.toLowerCase())) {
        score -= 3;
      }
    }

    return Math.max(0, Math.min(15, score));
  });
}

// 6️⃣ Time-based trap detection
async function timeTrapScore(token) {
  return withRpc(async (prov) => {
    const code = await prov.getCode(token);

    const traps = [
      "block.timestamp",
      "block.number",
      "tradingEnabled",
      "launchTime"
    ];

    let hits = 0;
    for (const t of traps) {
      if (code.includes(t)) hits++;
    }

    if (hits >= 3) return 0;
    if (hits === 2) return 3;
    if (hits === 1) return 6;
    return 10;
  });
}

/* ================= MAIN ================= */
export async function securitySafetyFree(token) {
  let score = 0;

  score += await bytecodeHashSimilarityCheck(token, provider); // 20
  score += await lpBurnScore(token);                           // 20
  score += await devWalletScore(token);                        // 10
  score += await ownershipScore(token);                        // 5
  score += await sizeScore(token);                             // 5
  score += await honeypotScore(token);                         // 15
  score += await timeTrapScore(token);                         // 10

  console.log(`🔐 FREE RPC security score for ${token}: ${score}/85`);
  return score >= 70;
}