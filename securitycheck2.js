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

const BURN_ADDRESSES = [
  ethers.ZeroAddress,
  "0x000000000000000000000000000000000000dEaD"
];

const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
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

// Resolve token from pair
async function resolveTokenFromPair(pair, prov) {
  const lp = new ethers.Contract(pair, PAIR_ABI, prov);
  const [t0, t1] = await Promise.all([lp.token0(), lp.token1()]);
  if (t0.toLowerCase() === WBNB.toLowerCase()) return t1;
  if (t1.toLowerCase() === WBNB.toLowerCase()) return t0;
  throw new Error("Pair does not contain WBNB");
}

/* ================= CORE CHECKS ================= */

// 1️⃣ LP burn
async function lpBurnScore(pair) {
  return withRpc(async (prov) => {
    const token = await resolveTokenFromPair(pair, prov);
    const lp = new ethers.Contract(pair, PAIR_ABI, prov);
    const total = Number(ethers.formatUnits(await lp.totalSupply(), 18));
    if (!total) return 0;

    let burned = 0;
    for (const addr of BURN_ADDRESSES) {
      burned += Number(ethers.formatUnits(await lp.balanceOf(addr), 18));
    }

    return burned / total >= 0.9 ? 20 : 5;
  });
}

// 2️⃣ Dev wallet
async function devWalletScore(pair) {
  return withRpc(async (prov) => {
    const token = await resolveTokenFromPair(pair, prov);
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
async function ownershipScore(pair) {
  return withRpc(async (prov) => {
    const token = await resolveTokenFromPair(pair, prov);
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
async function sizeScore(pair) {
  return withRpc(async (prov) => {
    const token = await resolveTokenFromPair(pair, prov);
    const code = await prov.getCode(token);
    return code.length < 24_000 ? 5 : 0;
  });
}

// 5️⃣ Honeypot heuristic
async function honeypotScore(pair) {
  return withRpc(async (prov) => {
    const token = await resolveTokenFromPair(pair, prov);
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
async function timeTrapScore(pair) {
  return withRpc(async (prov) => {
    const token = await resolveTokenFromPair(pair, prov);
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
export async function securitySafety(pairAddress, tokenMint) {
  // use pairAddress for pair/liquidity checks
  const pairOk = await somePairCheck(pairAddress);

  // use tokenMint for bytecode/contract checks
  const bytecodeScore = await bytecodeHashSimilarityCheck(tokenMint);

  if (!pairOk || bytecodeScore < 10) return false;
  return true;
  let score = 0;

  score += await bytecodeHashSimilarityCheck(pair, provider); // 20
  score += await lpBurnScore(pair);                           // 20
  score += await devWalletScore(pair);                        // 10
  score += await ownershipScore(pair);                        // 5
  score += await sizeScore(pair);                             // 5
  score += await honeypotScore(pair);                         // 15
  score += await timeTrapScore(pair);                         // 10

  console.log(`🔐 FREE RPC security score for pair ${pair}: ${score}/85`);
  return score >= 70;
}