// file: scanedPrice.js
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
  process.env.RPC_URL_8,
].filter(Boolean);

if (RPC_URLS.length < 2) throw new Error("At least 2 RPC URLs required");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

const rpcQueue = new PQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 5,
  carryoverConcurrencyCount: true,
});

/* ================= ADDRESSES ================= */
function reqEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

const ADDRESSES = {
  WBNB: ethers.getAddress(reqEnv("WBNB_ADDRESS")),
  FACTORY: ethers.getAddress(reqEnv("PANCAKE_FACTORY")),
  ROUTER: ethers.getAddress(reqEnv("PANCAKE_ROUTER")), // kept for compatibility
};

/* ================= ABIs ================= */
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];

const PAIR_ABI = [
  "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
];

const ERC20_ABI = [
  "function totalSupply() view returns(uint256)",
  "function decimals() view returns(uint8)",
];

const JSON_FILE = "./potential_migrators.json";

/* ================= TELEGRAM (optional) ================= */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PRICE_TELEGRAM_ENABLED =
  String(process.env.PRICE_TELEGRAM_ENABLED || "false").toLowerCase() === "true";

async function sendTelegram(message) {
  if (!PRICE_TELEGRAM_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch {
    // pricing must not fail if Telegram fails
  }
}

/* ================= HELPERS ================= */
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
}

async function withRpcFailover(fn, retries = RPC_URLS.length) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      lastErr = err;
      rotateRpc();
      await new Promise((r) =>
        setTimeout(r, 150 + Math.floor(Math.random() * 150))
      );
    }
  }
  throw lastErr;
}

let migratorsCache = null;
function loadMigrators() {
  if (migratorsCache) return migratorsCache;
  if (!fs.existsSync(JSON_FILE)) {
    migratorsCache = [];
    return migratorsCache;
  }
  try {
    migratorsCache = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  } catch {
    migratorsCache = [];
  }
  return migratorsCache;
}

let bnbUsdCache = { ts: 0, price: null };
async function fetchBNBPriceUSD({ ttlMs = 15_000 } = {}) {
  const now = Date.now();
  if (bnbUsdCache.price && now - bnbUsdCache.ts < ttlMs) return bnbUsdCache.price;

  try {
    const resp = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
      { timeout: 7000 }
    );
    const data = await resp.json();
    const px = Number(data.price);
    if (!Number.isFinite(px) || px <= 0) return null;

    bnbUsdCache = { ts: now, price: px };
    return px;
  } catch {
    return null;
  }
}

function safeDiv(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function toNumberSafe(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ================= MAIN ================= */
/**
 * scanedPrice(tokenMintRaw, pairAddressRaw?, opts?)
 *
 * Compatibility contract:
 * - Default return: number (priceBNB) or null       <-- sellCaller.js expects this
 * - If opts.full === true: returns object or null   <-- swapExecutor.js can use this
 *
 * pairAddressRaw is optional (if provided and valid, we use it; else factory.getPair)
 */
export async function scanedPrice(tokenMintRaw, pairAddressRaw = null, opts = {}) {
  const wantFull = opts && opts.full === true;

  let tokenMint;
  try {
    tokenMint = ethers.getAddress(tokenMintRaw);
  } catch {
    return null;
  }

  // keep cache warm, do not enforce allowlist
  void loadMigrators();

  let pairOverride = null;
  if (pairAddressRaw) {
    try {
      pairOverride = ethers.getAddress(pairAddressRaw);
    } catch {
      pairOverride = null;
    }
  }

  const result = await withRpcFailover(async (prov) => {
    // --------- Pair ---------
    let pairAddress = pairOverride;
    if (!pairAddress) {
      const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, prov);
      const p = await factory.getPair(tokenMint, ADDRESSES.WBNB);
      if (!p || p === ethers.ZeroAddress) return null;
      pairAddress = ethers.getAddress(p);
    }

    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);

    // --------- Pair meta + reserves ---------
    const [reserves, token0, token1] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.token1(),
    ]);

    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    // Confirm token/WBNB pair
    if (t0 !== tokenMint.toLowerCase() && t1 !== tokenMint.toLowerCase()) return null;
    if (t0 !== ADDRESSES.WBNB.toLowerCase() && t1 !== ADDRESSES.WBNB.toLowerCase())
      return null;

    const r0 = BigInt(reserves.reserve0);
    const r1 = BigInt(reserves.reserve1);

    const tokenContract = new ethers.Contract(tokenMint, ERC20_ABI, prov);
    const [decimalsRaw, totalSupplyRaw] = await Promise.all([
      tokenContract.decimals().catch(() => 18),
      tokenContract.totalSupply().catch(() => 0n),
    ]);

    const tokenDecimals = Number.isFinite(Number(decimalsRaw))
      ? Number(decimalsRaw)
      : 18;

    const tokenReserveRaw = t0 === tokenMint.toLowerCase() ? r0 : r1;
    const wbnbReserveRaw = t0 === ADDRESSES.WBNB.toLowerCase() ? r0 : r1;

    if (tokenReserveRaw === 0n || wbnbReserveRaw === 0n) return null;

    const tokenReserve = Number(ethers.formatUnits(tokenReserveRaw, tokenDecimals));
    const wbnbReserve = Number(ethers.formatUnits(wbnbReserveRaw, 18));

    const priceBNB = safeDiv(wbnbReserve, tokenReserve);
    if (priceBNB === null) return null;

    const bnbPriceUSD = await fetchBNBPriceUSD();
    const priceUSD = bnbPriceUSD ? priceBNB * bnbPriceUSD : null;

    const totalSupply = toNumberSafe(ethers.formatUnits(totalSupplyRaw, tokenDecimals));
    const marketCapBNB = totalSupply !== null ? totalSupply * priceBNB : null;

    const liquidityBNB = wbnbReserve;
    const liquidityUSD = bnbPriceUSD ? liquidityBNB * bnbPriceUSD : null;

    await sendTelegram(
      [
        `Token: ${tokenMint}`,
        `Pair: ${pairAddress}`,
        `Price(BNB): ${priceBNB.toFixed(10)}`,
        `Liquidity(BNB): ${liquidityBNB.toFixed(4)}`,
      ].join("\n")
    );

    return {
      ok: true,
      token: tokenMint, // checksum
      pair: pairAddress, // checksum
      priceBNB,
      priceUSD,
      reserves: { token: tokenReserve, wbnb: wbnbReserve },
      liquidityBNB,
      liquidityUSD,
      tokenDecimals,
      marketCapBNB,
    };
  }).catch(() => null);

  if (!result) return null;
  return wantFull ? result : result.priceBNB;
}