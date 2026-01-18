// file: scanedPrice.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import fetch from "node-fetch";

/* ================= NORMALIZE (NO REGEX) ================= */
function normalizeAddr(x) {
  if (!x) return null;
  try {
    return ethers.getAddress(String(x).trim());
  } catch {
    return null;
  }
}

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

const rpcQueue = new PQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 5,
  carryoverConcurrencyCount: true
});

/* ================= ADDRESSES ================= */
const requiredEnv = ["WBNB_ADDRESS", "PANCAKE_FACTORY", "PANCAKE_ROUTER"];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`❌ Missing env var: ${key}`);
}

const ADDRESSES = {
  WBNB: normalizeAddr(process.env.WBNB_ADDRESS),
  FACTORY: normalizeAddr(process.env.PANCAKE_FACTORY),
  ROUTER: normalizeAddr(process.env.PANCAKE_ROUTER)
};

if (!ADDRESSES.WBNB) throw new Error("❌ Invalid WBNB_ADDRESS in env");
if (!ADDRESSES.FACTORY) throw new Error("❌ Invalid PANCAKE_FACTORY in env");
if (!ADDRESSES.ROUTER) throw new Error("❌ Invalid PANCAKE_ROUTER in env");

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

/* ================= OPTIONAL JSON (does not block) ================= */
const JSON_FILE = "./potential_migrators.json";

function loadMigratorsSafe() {
  if (!fs.existsSync(JSON_FILE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/* ================= TELEGRAM ================= */
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
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
  } catch {
    // must not fail pricing
  }
}

/* ================= HELPERS ================= */
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
}

async function withRpcFailover(fn, retries = RPC_URLS.length) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      lastError = err;
      rotateRpc();
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message || String(lastError)}`);
}

let bnbUsdCache = { ts: 0, px: null };
async function fetchBNBPriceUSD({ ttlMs = 15_000 } = {}) {
  const now = Date.now();
  if (bnbUsdCache.px && now - bnbUsdCache.ts < ttlMs) return bnbUsdCache.px;

  try {
    const resp = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
    const data = await resp.json();
    const px = Number(data?.price);
    if (!Number.isFinite(px) || px <= 0) return null;
    bnbUsdCache = { ts: now, px };
    return px;
  } catch {
    return null;
  }
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ================= MAIN FUNCTION ================= */
/**
 * scanedPrice(tokenMint, pairAddress?, opts?)
 *
 * Backward compatible behavior:
 * - If opts.full === true: returns full object
 * - Else: returns priceBNB number
 *
 * Pair behavior:
 * - If pairAddress is provided and valid, it uses it
 * - Else it resolves pair from factory (token/WBNB)
 *
 * JSON behavior:
 * - potential_migrators.json is OPTIONAL and never blocks pricing
 */
export async function scanedPrice(tokenMintRaw, pairAddressRaw = null, opts = {}) {
  const wantFull = opts?.full === true;
  const debug = opts?.debug === true;

  const tokenMint = normalizeAddr(tokenMintRaw);
  if (!tokenMint) {
    if (debug) console.log("[scanedPrice] invalid token address:", tokenMintRaw);
    return null;
  }

  let pairOverride = null;
  if (pairAddressRaw) {
    pairOverride = normalizeAddr(pairAddressRaw);
    if (!pairOverride && debug) console.log("[scanedPrice] invalid pair override:", pairAddressRaw);
  }

  // Non-blocking warm cache hook
  void loadMigratorsSafe();

  const out = await withRpcFailover(async (prov) => {
    // 1) pair
    let pairAddress = pairOverride;
    if (!pairAddress) {
      const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, prov);
      const p = await factory.getPair(tokenMint, ADDRESSES.WBNB);
      if (!p || p === ethers.ZeroAddress) {
        if (debug) console.log("[scanedPrice] getPair returned zero (no token/WBNB pair)");
        return null;
      }
      pairAddress = ethers.getAddress(p);
    }

    // 2) reserves + meta
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    const [reserves, token0, token1] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.token1()
    ]);

    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    const tk = tokenMint.toLowerCase();
    const wb = ADDRESSES.WBNB.toLowerCase();

    const isTokenInPair = t0 === tk || t1 === tk;
    const isWbnbInPair = t0 === wb || t1 === wb;

    if (!isTokenInPair || !isWbnbInPair) {
      if (debug) {
        console.log("[scanedPrice] pair is not token/WBNB");
        console.log(" token:", tokenMint);
        console.log(" pair:", pairAddress);
        console.log(" token0:", token0);
        console.log(" token1:", token1);
      }
      return null;
    }

    const r0 = BigInt(reserves.reserve0);
    const r1 = BigInt(reserves.reserve1);

    // 3) decimals + totalSupply
    const tokenContract = new ethers.Contract(tokenMint, ERC20_ABI, prov);
    const [decRaw, tsRaw] = await Promise.all([
      tokenContract.decimals().catch(() => 18),
      tokenContract.totalSupply().catch(() => 0n)
    ]);

    const tokenDecimals = Number.isFinite(Number(decRaw)) ? Number(decRaw) : 18;

    // 4) pick correct reserve sides
    const tokenReserveRaw = t0 === tk ? r0 : r1;
    const wbnbReserveRaw = t0 === wb ? r0 : r1;

    if (tokenReserveRaw === 0n || wbnbReserveRaw === 0n) {
      if (debug) console.log("[scanedPrice] zero reserves");
      return null;
    }

    const tokenReserve = safeNum(ethers.formatUnits(tokenReserveRaw, tokenDecimals));
    const wbnbReserve = safeNum(ethers.formatUnits(wbnbReserveRaw, 18));

    if (!Number.isFinite(tokenReserve) || tokenReserve <= 0) return null;
    if (!Number.isFinite(wbnbReserve) || wbnbReserve <= 0) return null;

    const priceBNB = wbnbReserve / tokenReserve;
    if (!Number.isFinite(priceBNB) || priceBNB <= 0) return null;

    // 5) liquidity + marketcap (BNB)
    const liquidityBNB = wbnbReserve;

    let totalSupply = null;
    try {
      totalSupply = safeNum(ethers.formatUnits(tsRaw, tokenDecimals));
      if (!Number.isFinite(totalSupply) || totalSupply <= 0) totalSupply = null;
    } catch {
      totalSupply = null;
    }

    const marketCapBNB = totalSupply !== null ? totalSupply * priceBNB : null;

    // 6) USD conversion (best effort)
    const bnbUsd = await fetchBNBPriceUSD();
    const priceUSD = bnbUsd ? priceBNB * bnbUsd : null;
    const liquidityUSD = bnbUsd ? liquidityBNB * bnbUsd : null;

    // 7) Telegram (optional)
    await sendTelegram(
      [
        `Token: ${tokenMint}`,
        `Pair: ${pairAddress}`,
        `Price BNB: ${priceBNB.toFixed(10)}`,
        `Price USD: ${priceUSD ? priceUSD.toFixed(6) : "N/A"}`,
        `MarketCap BNB: ${marketCapBNB !== null ? marketCapBNB.toFixed(6) : "N/A"}`,
        `Liquidity BNB: ${liquidityBNB.toFixed(6)}`
      ].join("\n")
    );

    return {
      ok: true,
      token: tokenMint,
      pair: pairAddress,
      priceBNB,
      priceUSD,
      liquidityBNB,
      liquidityUSD,
      marketCap: marketCapBNB,   // your old key
      marketCapBNB,              // extra key
      bnbReserve: wbnbReserve,   // your old key
      totalSupply,
      tokenDecimals,
      reserves: { token: tokenReserve, wbnb: wbnbReserve }
    };
  }).catch((e) => {
    if (debug) console.log("[scanedPrice] hard fail:", e?.message || String(e));
    return null;
  });

  if (!out || out.ok !== true) return null;
  return wantFull ? out : out.priceBNB;
}