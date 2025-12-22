import dotenv from 'dotenv';
dotenv.config();
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import fetch from "node-fetch";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_10 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_20 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (RPC_URLS.length < 1) {
  throw new Error("❌ At least one RPC_URL_* required");
}

/* ================= CONSTANTS ================= */
const PANCAKE_FACTORY = ethers.getAddress(
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"
);

const WBNB = ethers.getAddress(
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
);

const OUTPUT_FILE = "./potential_migrators.json";
const MIN_BNB_LIQUIDITY = 20;
const SCAN_INTERVAL_MS = 5_000;
const POOL_AGE_THRESHOLD_MS = 5 * 60 * 1000;

const PAIR_CREATED_TOPIC = ethers.id(
  "PairCreated(address,address,address,uint256)"
);

/* ================= TELEGRAM ================= */
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* ================= RPC QUEUE ================= */
const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 6
});

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

/* ================= START BLOCK ================= */
let lastBlock = await provider.getBlockNumber();
console.log("[*] Starting from block:", lastBlock);

/* ================= HELPERS ================= */
function loadExisting() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveJSON(data) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
}

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.warn("Telegram failed:", err.message);
  }
}

async function withRpcFailover(fn) {
  let lastError;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      console.warn(`⚠️ RPC failed (${RPC_URLS[rpcIndex]}): ${err.message}`);
      lastError = err;
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
      console.log(`➡️ Switched RPC → ${RPC_URLS[rpcIndex]}`);
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

/* ================= ON-CHAIN HELPERS ================= */
async function getBNBLiquidity(pairAddress, tokenMint) {
  return withRpcFailover(async (prov) => {
    const PAIR_ABI = [
      "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
      "function token0() view returns(address)",
      "function token1() view returns(address)"
    ];

    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    const [reserves, token0] = await Promise.all([
      pair.getReserves(),
      pair.token0()
    ]);

    const bnbReserve =
      token0.toLowerCase() === tokenMint.toLowerCase()
        ? reserves.reserve1
        : reserves.reserve0;

    return Number(ethers.formatUnits(bnbReserve, 18));
  });
}

async function getTokenInfo(tokenAddress) {
  return withRpcFailover(async (prov) => {
    const ERC20_ABI = [
      "function symbol() view returns(string)",
      "function name() view returns(string)"
    ];
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, prov);
      const [symbol, name] = await Promise.all([
        token.symbol(),
        token.name()
      ]);
      return { symbol, name };
    } catch {
      return { symbol: null, name: null };
    }
  });
}

/* ================= SAVE PAIR ================= */
function savePair(entry) {
  const now = Date.now();
  if (now - entry.detectedat > POOL_AGE_THRESHOLD_MS) return;

  const data = loadExisting();
  if (data.some(p => p.pairaddress === entry.pairaddress)) return;

  data.push(entry);
  saveJSON(data);

  console.log("✅ New token detected:", entry.tokenSymbol || entry.tokenmint);

  sendTelegram(
    `🚀 *NEW TOKEN DETECTED*
Token: ${entry.tokenSymbol || entry.tokenmint}
Name: ${entry.tokenName || "N/A"}
Pair: ${entry.pairaddress}
Liquidity: ${entry.bnbLiquidity} BNB
Block: ${entry.blocknumber}`
  );
}

/* ================= MAIN SCAN ================= */
async function scan() {
  const currentBlock = await withRpcFailover(p => p.getBlockNumber());
  if (currentBlock <= lastBlock) return;

  const logs = await withRpcFailover(p =>
    p.getLogs({
      address: ethers.getAddress(PANCAKE_FACTORY),
      fromBlock: lastBlock + 1,
      toBlock: currentBlock,
      topics: [PAIR_CREATED_TOPIC]
    })
  );

  const existingPairs = loadExisting().map(p => p.pairaddress.toLowerCase());

  for (const log of logs) {
    const token0 = ethers.getAddress("0x" + log.topics[1].slice(26));
    const token1 = ethers.getAddress("0x" + log.topics[2].slice(26));
    const pair = ethers.getAddress("0x" + log.data.slice(26, 66));

    if (existingPairs.includes(pair.toLowerCase())) continue;

    let tokenMint = null;
    if (token0 === WBNB) tokenMint = token1;
    else if (token1 === WBNB) tokenMint = token0;
    else continue;

    const bnbLiquidity = await getBNBLiquidity(pair, tokenMint);
    if (bnbLiquidity < MIN_BNB_LIQUIDITY) continue;

    const tokenInfo = await getTokenInfo(tokenMint);

    savePair({
      tokenmint: tokenMint,
      pairaddress: pair,
      blocknumber: log.blockNumber,
      detectedat: Date.now(),
      bnbLiquidity,
      tokenSymbol: tokenInfo.symbol,
      tokenName: tokenInfo.name
    });
  }

  lastBlock = currentBlock;
}

/* ================= LOOP ================= */
setInterval(() => {
  scan().catch(err => console.error("Scan error:", err.message));
}, SCAN_INTERVAL_MS);