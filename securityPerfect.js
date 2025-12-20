// file: securityPerfect.js
import fs from "fs";
import { config } from "dotenv";
import PQueue from "p-queue";
import { ethers } from "ethers";
config();

/* ================= RPC CONFIG ================= */
const RPC_READ = process.env.RPC_READ;   // free read RPC
const RPC_LOGS = process.env.RPC_LOGS;   // free logs RPC

const providerRead = new ethers.JsonRpcProvider(RPC_READ);
const providerLogs = new ethers.JsonRpcProvider(RPC_LOGS);

/* ================= RATE LIMIT ================= */
const readQueue = new PQueue({
  interval: 1000,
  intervalCap: 5,
  concurrency: 1,
  carryoverConcurrencyCount: true,
});

const logsQueue = new PQueue({
  interval: 1000,
  intervalCap: 5,
  concurrency: 1,
  carryoverConcurrencyCount: true,
});

/* ================= CONSTANTS ================= */
const POTENTIAL_MIGRATORS = "./potential_migrators.json";
const FACTORY_ADDRESS = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const WBNB_ADDRESS = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const MIN_SECURITY_SCORE = Number(process.env.MIN_SECURITY_SCORE || 50);

/* ================= ABI ================= */
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)"
];

/* ================= HELPERS ================= */
function scoreBool(cond, val) {
  return cond ? val : 0;
}

function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function safe(queue, fn) {
  try {
    return await queue.add(fn);
  } catch {
    return null;
  }
}

/* ================= BUYER STATS ================= */
async function getBuyStats(tokenAddress) {
  try {
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ["function getPair(address,address) view returns(address)"],
      providerRead
    );

    const pair = await safe(readQueue, () =>
      factory.getPair(tokenAddress, WBNB_ADDRESS)
    );

    if (!pair || pair === ethers.ZeroAddress) return null;

    const latest = await safe(logsQueue, () => providerLogs.getBlockNumber());
    if (!latest) return null;

    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    const logs = await safe(logsQueue, () =>
      providerLogs.getLogs({
        address: tokenAddress,
        topics: [transferTopic],
        fromBlock: latest - 15_000,
        toBlock: latest,
      })
    );

    if (!logs) return null;

    const buyers = new Set();
    let volume = 0;

    for (const log of logs) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "address", "uint256"],
        log.data
      );

      if (decoded[0].toLowerCase() === pair.toLowerCase()) {
        buyers.add(decoded[1].toLowerCase());
        volume += Number(ethers.formatUnits(decoded[2], 18));
      }
    }

    return {
      uniqueBuyers: buyers.size,
      totalVolumeBNB: volume,
    };
  } catch {
    return null;
  }
}

/* ================= ANTI-BOT & EARLY LIQUIDITY DUMP ================= */
async function checkLiquidityDump(tokenMint) {
  try {
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      ["function getPair(address,address) view returns(address)"],
      providerRead
    );

    const pair = await safe(readQueue, () =>
      factory.getPair(tokenMint, WBNB_ADDRESS)
    );
    if (!pair || pair === ethers.ZeroAddress) return 0;

    const PAIR_ABI = [
      "function getReserves() view returns (uint112, uint112, uint32)",
      "function token0() view returns(address)",
      "function token1() view returns(address)"
    ];
    const pairContract = new ethers.Contract(pair, PAIR_ABI, providerRead);

    const [reserve0, reserve1] = await safe(readQueue, () =>
      pairContract.getReserves()
    );

    const bnbReserve =
      (await pairContract.token0()) === tokenMint ? reserve1 : reserve0;
    const liquidityBNB = Number(ethers.formatUnits(bnbReserve, 18));

    return liquidityBNB >= 20 ? 10 : 0; // now requires at least 20 BNB
  } catch {
    return 0;
  }
}

async function checkAntiBot(tokenMint) {
  try {
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const latest = await safe(logsQueue, () => providerLogs.getBlockNumber());
    const logs = await safe(logsQueue, () =>
      providerLogs.getLogs({
        address: tokenMint,
        topics: [transferTopic],
        fromBlock: latest - 2_000,
        toBlock: latest,
      })
    );

    if (!logs || logs.length === 0) return 5; // assume no anti-bot

    const senderCount = {};
    for (const log of logs) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "address", "uint256"],
        log.data
      );
      const sender = decoded[0].toLowerCase();
      senderCount[sender] = (senderCount[sender] || 0) + 1;
    }

    const maxSends = Math.max(...Object.values(senderCount));
    return maxSends <= 3 ? 5 : 0; // penalize if one address dominates transfers
  } catch {
    return 0;
  }
}

/* ================= MAIN FUNCTION ================= */
export async function securityPerfect(tokenMint) {
  const tokens = readJSON(POTENTIAL_MIGRATORS);
  if (!tokens.find(t => t.tokenmint?.toLowerCase() === tokenMint.toLowerCase())) {
    return false;
  }

  const contract = new ethers.Contract(tokenMint, ERC20_ABI, providerRead);
  let score = 0;
  let ownerAddress = "UNKNOWN";

  /* ===== ERC20 VALIDATION ===== */
  const basic = await Promise.all([
    safe(readQueue, () => contract.name()),
    safe(readQueue, () => contract.symbol()),
    safe(readQueue, () => contract.decimals()),
    safe(readQueue, () => contract.totalSupply()),
  ]);

  if (basic.some(v => v === null)) return false;

  /* ===== OWNERSHIP ===== */
  const owner = await safe(readQueue, () => contract.owner());
  if (owner) {
    ownerAddress = owner;
    if (
      owner === ethers.ZeroAddress ||
      owner.toLowerCase() === "0x000000000000000000000000000000000000dead"
    ) {
      score += 20;
    }
  }

  /* ===== BYTECODE ANALYSIS ===== */
  const bytecode = await safe(readQueue, () => providerRead.getCode(tokenMint));
  if (!bytecode) return false;

  const code = bytecode.toLowerCase();
  score += scoreBool(!code.includes("mint"), 25);
  score += scoreBool(!code.includes("blacklist") && !code.includes("whitelist"), 20);
  score += scoreBool(!code.includes("enabletrading"), 10);
  score += scoreBool(!code.includes("maxtx") && !code.includes("maxwallet"), 15);

  /* ===== BUYERS / VOLUME ===== */
  const stats = await getBuyStats(tokenMint);
  if (stats) {
    score += scoreBool(stats.uniqueBuyers >= 15, 5);
    score += scoreBool(stats.totalVolumeBNB >= 1000, 5);
  }

  /* ===== EARLY LIQUIDITY DUMP & ANTI-BOT ===== */
  score += await checkLiquidityDump(tokenMint); // 0�10
  score += await checkAntiBot(tokenMint);       // 0�5

  console.log(` ${tokenMint} | score=${score} | owner=${ownerAddress}`);
  return score >= MIN_SECURITY_SCORE;
}