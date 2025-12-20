             newListingAlert.js
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import fetch from "node-fetch";

const RPC_URLS = [
  process.env.RPC_URL_10 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_20 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("❌ At least one RPC_URL_* required");

const PANCAKE_FACTORY = "0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const OUTPUT_FILE = "./potential_migrators.json";
const MIN_BNB_LIQUIDITY = 20;
const PAIR_CREATED_TOPIC = ethers.id("PairCreated(address,address,address,uint256)");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Pool age threshold: only consider pools created in the last 5 minutes
const POOL_AGE_THRESHOLD_MS = 5 * 60 * 1000;

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });
let activeRpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

let lastBlock = await provider.getBlockNumber();
console.log("[*] Starting from block:", lastBlock);

// ---------------- HELPERS ----------------
function loadExisting() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8")); } catch { return []; }
}

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }),
    });
  } catch (err) { console.error("Telegram failed:", err.message); }
}

function savePair(entry) {
  const now = Date.now();
  if (now - entry.detectedat > POOL_AGE_THRESHOLD_MS) {
    console.log(`⏳ Skipping ${entry.tokenmint}, pool older than 5 minutes`);
    return;
  }

  const data = loadExisting();
  if (data.some(p => p.pairaddress === entry.pairaddress)) return;

  data.push(entry);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));

  console.log("✅ New token detected:", entry.tokenSymbol || entry.tokenmint);
  const msg = `🚀 *NEW TOKEN DETECTED*\nToken: ${entry.tokenSymbol || entry.tokenmint}\nName: ${entry.tokenName || "N/A"}\nPair: ${entry.pairaddress}\nQuote: ${entry.quotetoken}\nLiquidity: ${entry.bnbLiquidity} BNB\nBlock: ${entry.blocknumber}`;
  sendTelegram(msg);
}

async function getBNBLiquidity(pairAddress, tokenMint) {
  const PAIR_ABI = [
    "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
    "function token0() view returns(address)",
    "function token1() view returns(address)"
  ];
  const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pairContract.getReserves();
  const token0 = await pairContract.token0();
  let bnbReserve = token0.toLowerCase() === tokenMint.toLowerCase() ? reserve1 : reserve0;
  return Number(ethers.formatUnits(bnbReserve, 18));
}

async function getTokenInfo(tokenAddress) {
  const ERC20_ABI = [
    "function symbol() view returns(string)",
    "function name() view returns(string)"
  ];
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, name] = await Promise.all([token.symbol(), token.name()]);
    return { symbol, name };
  } catch {
    return { symbol: null, name: null };
  }
}

async function withRpcFailover(fn) {
  let lastError;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try { return await rpcQueue.add(() => fn(provider)); }
    catch (err) {
      console.warn(`⚠️ RPC failed (${RPC_URLS[activeRpcIndex]}): ${err.message}`);
      lastError = err;
      activeRpcIndex = (activeRpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);
      console.log(`➡️ Switching RPC to: ${RPC_URLS[activeRpcIndex]}`);
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

// ---------------- MAIN LOOP ----------------
async function scan() {
  const currentBlock = await withRpcFailover(p => p.getBlockNumber());
  if (currentBlock <= lastBlock) return;

  const logs = await withRpcFailover(p =>
    p.getLogs({ address: PANCAKE_FACTORY, fromBlock: lastBlock + 1, toBlock: currentBlock, topics: [PAIR_CREATED_TOPIC] })
  );

  const existingPairs = loadExisting().map(p => p.pairaddress.toLowerCase());

  for (const log of logs) {
    const token0 = ethers.getAddress("0x" + log.topics[1].slice(26));
    const token1 = ethers.getAddress("0x" + log.topics[2].slice(26));
    const pair = ethers.getAddress("0x" + log.data.slice(26, 66));

    if (existingPairs.includes(pair.toLowerCase())) continue;

    let tokenMint = null, quote = null;
    if (token0 === WBNB) { tokenMint = token1; quote = "WBNB"; }
    else if (token1 === WBNB) { tokenMint = token0; quote = "WBNB"; }
    else continue;

    const bnbLiquidity = await getBNBLiquidity(pair, tokenMint);
    if (bnbLiquidity < MIN_BNB_LIQUIDITY) continue;

    const tokenInfo = await getTokenInfo(tokenMint);

    savePair({
      tokenmint: tokenMint,
      quotetoken: quote,
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

setInterval(async () => {
  try { await scan(); } catch (e) { console.error("Scan error:", e.message); }
}, 5000);
