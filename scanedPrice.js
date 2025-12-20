// file: scanedPrice.js
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_7,
  process.env.RPC_URL_6,
  process.env.RPC_URL_5,
  process.env.RPC_URL_8
].filter(Boolean);

if (RPC_URLS.length < 2) throw new Error("❌ At least 2 RPC URLs required");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5 });

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FACTORY_ADDRESS = "0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) external view returns (address pair)"];
const PAIR_ABI = [
  "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

const JSON_FILE = "./potential_migrators.json";

/* ================= TELEGRAM ================= */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    });
  } catch (err) {
    console.warn("Failed to send Telegram:", err.message);
  }
}

/* ================= HELPERS ================= */
function loadMigrators() {
  if (!fs.existsSync(JSON_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  } catch {
    return [];
  }
}

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
  console.log(`➡️ Switched RPC → ${RPC_URLS[rpcIndex]}`);
}

async function withRpcFailover(fn, retries = RPC_URLS.length) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      console.warn(`⚠️ RPC failed (${RPC_URLS[rpcIndex]}): ${err.message}`);
      lastError = err;
      rotateRpc();
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

async function fetchBNBPriceUSD() {
  try {
    const resp = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
    const data = await resp.json();
    return Number(data.price);
  } catch (err) {
    console.warn("Failed to fetch BNB price:", err.message);
    return null;
  }
}

/* ================= MAIN FUNCTION ================= */
export async function scanedPrice(tokenMint) {
  const data = loadMigrators();
  const entry = data.find(e => e.tokenmint.toLowerCase() === tokenMint.toLowerCase());
  if (!entry) {
    console.warn("Token not found in potential_migrators.json");
    return null;
  }

  return await withRpcFailover(async (prov) => {
    try {
      const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, prov);
      const pairAddress = await factory.getPair(tokenMint, WBNB);
      if (pairAddress === ethers.constants.AddressZero) return null;

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
      const reserves = await rpcQueue.add(() => pair.getReserves());
const token0 = await rpcQueue.add(() => pair.token0());

      let priceBNB;
      if (token0.toLowerCase() === tokenMint.toLowerCase()) {
        priceBNB = Number(ethers.formatUnits(reserve1, 18)) / Number(ethers.formatUnits(reserve0, 18));
      } else {
        priceBNB = Number(ethers.formatUnits(reserve0, 18)) / Number(ethers.formatUnits(reserve1, 18));
      }

      const bnbPriceUSD = await fetchBNBPriceUSD();
      const priceUSD = bnbPriceUSD ? priceBNB * bnbPriceUSD : null;

      await sendTelegram(`📊 Token: ${tokenMint}\nPrice BNB: ${priceBNB}\nPrice USD: ${priceUSD || "N/A"}`);

      return { priceBNB, priceUSD };
    } catch (err) {
      console.error("Failed to fetch price:", err.message);
      return null;
    }
  });
}