// file: scanedPrice.js
import "dotenv/config";
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

if (RPC_URLS.length < 1) throw new Error("At least 1 RPC URL required");

function cleanAddr(x) {
  if (!x) return null;
  const s = String(x).trim().replace(/[^0-9a-fA-Fx]/g, "");
  try {
    return ethers.getAddress(s);
  } catch {
    return null;
  }
}

const WBNB = cleanAddr(process.env.WBNB_ADDRESS) || ethers.getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const FACTORY = cleanAddr(process.env.PANCAKE_FACTORY) || ethers.getAddress("0xca143ce32fe78f1f7019d7d551a6402fc5350c73");

/* ================= ABIs ================= */
const FACTORY_ABI = ["function getPair(address tokenA,address tokenB) view returns(address)"];
const PAIR_ABI = [
  "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];
const ERC20_ABI = [
  "function decimals() view returns(uint8)",
  "function totalSupply() view returns(uint256)"
];

/* ================= RPC FAILOVER ================= */
const rpcQueue = new PQueue({ concurrency: 1, interval: 800, intervalCap: 5 });
let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
}

async function withRpcFailover(fn) {
  let lastErr = null;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (e) {
      lastErr = e;
      rotateRpc();
    }
  }
  throw lastErr;
}

/* ================= BNB/USD CACHE ================= */
let bnbUsdCache = { ts: 0, price: null };

async function fetchBNBPriceUSD({ ttlMs = 15_000 } = {}) {
  const now = Date.now();
  if (bnbUsdCache.price && now - bnbUsdCache.ts < ttlMs) return bnbUsdCache.price;

  try {
    const resp = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
    const data = await resp.json();
    const px = Number(data?.price);
    if (!Number.isFinite(px) || px <= 0) return null;

    bnbUsdCache = { ts: now, price: px };
    return px;
  } catch {
    return null;
  }
}

/* ================= MAIN ================= */
/**
 * scanedPrice(tokenMint, pairAddress?, opts?)
 * - Default return: priceBNB number, or null
 * - opts.full === true returns full object (price, liquidity, marketcap, USD)
 */
export async function scanedPrice(tokenMintRaw, pairAddressRaw = null, opts = {}) {
  // inside scanedPrice()
  const wantFull = opts?.full === true;
  const debug = opts?.debug === true;

  const token = cleanAddr(tokenMintRaw);
  if (!token) {
    if (debug) console.log("[scanedPrice] invalid token address:", tokenMintRaw);
    return null;
  }

  let pairOverride = null;
  if (pairAddressRaw) {
    pairOverride = cleanAddr(pairAddressRaw);
    if (!pairOverride && debug) {
      console.log("[scanedPrice] invalid pair override, falling back to getPair:", pairAddressRaw);
    }
  }

  try {
    const out = await withRpcFailover(async (prov) => {
      // 1) resolve pair
      let pairAddress = pairOverride;

      if (!pairAddress) {
        const factory = new ethers.Contract(FACTORY, FACTORY_ABI, prov);
        const p = await factory.getPair(token, WBNB);
        if (!p || p === ethers.ZeroAddress) {
          if (debug) console.log("[scanedPrice] getPair returned zero");
          return null;
        }
        pairAddress = ethers.getAddress(p);
      }

      // 2) read reserves + tokens
      const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
      const [reserves, token0, token1] = await Promise.all([
        pair.getReserves(),
        pair.token0(),
        pair.token1()
      ]);

      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const tk = token.toLowerCase();
      const wb = WBNB.toLowerCase();

      // must be token/WBNB pair
      const isTokenInPair = (t0 === tk || t1 === tk);
      const isWbnbInPair = (t0 === wb || t1 === wb);
      if (!isTokenInPair || !isWbnbInPair) {
        if (debug) {
          console.log("[scanedPrice] pair is not token/WBNB");
          console.log(" token:", token);
          console.log(" pair:", pairAddress);
          console.log(" token0:", token0);
          console.log(" token1:", token1);
        }
        return null;
      }

      const r0 = BigInt(reserves.reserve0);
      const r1 = BigInt(reserves.reserve1);

      // 3) decimals + totalSupply
      const erc = new ethers.Contract(token, ERC20_ABI, prov);
      const [decRaw, tsRaw] = await Promise.all([
        erc.decimals().catch(() => 18),
        erc.totalSupply().catch(() => 0n)
      ]);

      const decimals = Number(decRaw);
      const tokenDecimals = Number.isFinite(decimals) ? decimals : 18;

      // 4) pick correct reserves
      const tokenReserveRaw = (t0 === tk) ? r0 : r1;
      const wbnbReserveRaw  = (t0 === wb) ? r0 : r1;

      if (tokenReserveRaw === 0n || wbnbReserveRaw === 0n) {
        if (debug) console.log("[scanedPrice] zero reserves");
        return null;
      }

      const tokenReserve = Number(ethers.formatUnits(tokenReserveRaw, tokenDecimals));
      const wbnbReserve  = Number(ethers.formatUnits(wbnbReserveRaw, 18));

      if (!Number.isFinite(tokenReserve) || tokenReserve <= 0) return null;
      if (!Number.isFinite(wbnbReserve) || wbnbReserve <= 0) return null;

      const priceBNB = wbnbReserve / tokenReserve;
      if (!Number.isFinite(priceBNB) || priceBNB <= 0) return null;

      // 5) liquidity + marketcap
      const liquidityBNB = wbnbReserve;

      let totalSupply = null;
      try {
        totalSupply = Number(ethers.formatUnits(tsRaw, tokenDecimals));
        if (!Number.isFinite(totalSupply) || totalSupply <= 0) totalSupply = null;
      } catch {
        totalSupply = null;
      }

      const marketCapBNB = totalSupply !== null ? totalSupply * priceBNB : null;

      // 6) USD conversion (best effort)
      const bnbUsd = await fetchBNBPriceUSD();
      const priceUSD = bnbUsd ? priceBNB * bnbUsd : null;
      const liquidityUSD = bnbUsd ? liquidityBNB * bnbUsd : null;

      return {
        ok: true,
        token,
        pair: pairAddress,
        priceBNB,
        priceUSD,
        liquidityBNB,
        liquidityUSD,
        marketCapBNB,
        totalSupply,
        tokenDecimals,
        reserves: { token: tokenReserve, wbnb: wbnbReserve }
      };
    });

    if (!out) return null;
    return wantFull ? out : out.priceBNB;
  } catch (e) {
    if (debug) console.log("[scanedPrice] hard fail:", e?.message || String(e));
    return null;
  }
}