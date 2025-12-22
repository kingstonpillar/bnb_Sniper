import dotenv from "dotenv";
dotenv.config();
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

/* ================= ADDRESSES ================= */
const requiredEnv = ["WBNB_ADDRESS", "PANCAKE_FACTORY", "PANCAKE_ROUTER"];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`❌ Missing env var: ${key}`);
}

const ADDRESSES = {
  WBNB: ethers.getAddress(process.env.WBNB_ADDRESS),
  FACTORY: ethers.getAddress(process.env.PANCAKE_FACTORY),
  ROUTER: ethers.getAddress(process.env.PANCAKE_ROUTER),
};

/* ================= ABIs ================= */
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];
const PAIR_ABI = [
  "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];
const ERC20_ABI = [
  "function totalSupply() view returns(uint256)",
  "function decimals() view returns(uint8)"
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
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
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
      await new Promise(r => setTimeout(r, 200)); // small delay
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
export async function scanedPrice(tokenMintRaw) {
  const tokenMint = ethers.getAddress(tokenMintRaw); // normalize to checksum
  const data = loadMigrators();
  const entry = data.find(e => e.tokenmint.toLowerCase() === tokenMint.toLowerCase());
  if (!entry) {
    console.warn("Token not found in potential_migrators.json");
    return null;
  }

  return await withRpcFailover(async (prov) => {
    try {
      // --------- Pair & Reserves ---------
      const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, prov);
      const pairAddress = await factory.getPair(tokenMint, ADDRESSES.WBNB);
      if (pairAddress === ethers.constants.AddressZero) return null;

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
      const reserves = await rpcQueue.add(() => pair.getReserves());
      const token0 = await rpcQueue.add(() => pair.token0());
      const token1 = await rpcQueue.add(() => pair.token1());

      let reserveToken, reserveWBNB;
      if (token0.toLowerCase() === tokenMint.toLowerCase()) {
        reserveToken = reserves.reserve0;
        reserveWBNB = reserves.reserve1;
      } else {
        reserveToken = reserves.reserve1;
        reserveWBNB = reserves.reserve0;
      }

      const priceBNB = Number(ethers.formatUnits(reserveWBNB, 18)) / Number(ethers.formatUnits(reserveToken, 18));
      const bnbPriceUSD = await fetchBNBPriceUSD();
      const priceUSD = bnbPriceUSD ? priceBNB * bnbPriceUSD : null;

      // --------- Token Supply & Market Cap ---------
      const tokenContract = new ethers.Contract(tokenMint, ERC20_ABI, prov);
      const totalSupplyRaw = await rpcQueue.add(() => tokenContract.totalSupply());
      const decimals = await rpcQueue.add(() => tokenContract.decimals());
      const totalSupply = Number(ethers.formatUnits(totalSupplyRaw, decimals));
      const marketCapBNB = totalSupply * priceBNB;

      // --------- Liquidity in BNB ---------
      const liquidityBNB = Number(ethers.formatUnits(reserveWBNB, 18));

      // --------- Telegram ---------
      await sendTelegram(
        `📊 Token: ${tokenMint}
Price BNB: ${priceBNB.toFixed(6)}
Price USD: ${priceUSD ? priceUSD.toFixed(2) : "N/A"}
MarketCap BNB: ${marketCapBNB.toFixed(4)}
Liquidity BNB: ${liquidityBNB.toFixed(4)}`
      );

      return {
        priceBNB,
        priceUSD,
        liquidityBNB,
        marketCap: marketCapBNB,
        bnbReserve: Number(ethers.formatUnits(reserveWBNB, 18))
      };
    } catch (err) {
      console.error("Failed to fetch price:", err.message);
      return null;
    }
  });
}