import "dotenv/config";
import { ethers } from "ethers";
import fetch from "node-fetch";

const RPC_URLS = [
  process.env.RPC_URL_8 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_9 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs available");

let provider = new ethers.JsonRpcProvider(RPC_URLS[0]);

// BSC WBNB
const WBNB = (process.env.WBNB || "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c").toLowerCase();

// Honeypot.is API (free)
const HONEYPOT_API = "https://api.honeypot.is/v2/IsHoneypot";

// GoPlus Labs Free Token Security API
// (requires free API key — sign up on gopluslabs.io)
const GOPLUS_API_KEY = process.env.GOPLUS_API_KEY || "";
const GOPLUS_SECURITY_API = "https://api.gopluslabs.io/token/security";

// ---------------- ABI ----------------
const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];

// ---------------- HELPERS ----------------
async function safeFetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // fallback raw
    return { raw: text };
  }
}

function normalize(address) {
  try {
    return ethers.getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

// ---------------- PAIR → TOKEN ----------------
async function resolveTokenFromPair(pairAddress) {
  const p = normalize(pairAddress);
  if (!p) return null;
  const pair = new ethers.Contract(p, PAIR_ABI, provider);

  try {
    const t0 = (await pair.token0()).toLowerCase();
    const t1 = (await pair.token1()).toLowerCase();
    if (t0 === WBNB) return t1;
    if (t1 === WBNB) return t0;
  } catch {}
  return null;
}

// ---------------- Honeypot.is Free API ----------------
async function checkHoneypotIs(token) {
  const url = `${HONEYPOT_API}?address=${token}&chainID=56`;
  const data = await safeFetchJson(url);
  // typical JSON:
  // {honeypotResult: {buyTax, sellTax, isHoneypot, transferTax}, simulationSuccess, ...}
  const result = data?.honeypotResult || {};
  return {
    success: Boolean(data?.honeypotResult),
    isHoneypot: Boolean(result.isHoneypot),
    buyTax: typeof result.buyTax === "number" ? result.buyTax : null,
    sellTax: typeof result.sellTax === "number" ? result.sellTax : null,
    transferTax: typeof result.transferTax === "number" ? result.transferTax : null
  };
}

// ---------------- GoPlus Free API ----------------
async function checkGoPlusSecurity(token) {
  if (!GOPLUS_API_KEY) {
    return { error: "MISSING_GOPLUS_API_KEY" };
  }
  const u = new URL(GOPLUS_SECURITY_API);
  // GoPlus expects chain + contract
  u.searchParams.set("chain", "bsc");
  u.searchParams.set("contract", token);
  u.searchParams.set("apikey", GOPLUS_API_KEY);

  const data = await safeFetchJson(u.toString());

  // GoPlus returns result keyed by contract:
  // { code, result: { [token]: {...fields...} } }
  const entry = data?.result?.[token.toLowerCase()] || null;
  if (!entry) {
    return { error: "NO_DATA_FROM_GOPLUS" };
  }

  // Extract some useful signals:
  const signals = {
    is_honeypot: entry.is_honeypot === "1",
    cannot_sell_all: entry.cannot_sell_all === "1",
    is_blacklisted: entry.is_blacklisted === "1",
    transfer_pausable: entry.transfer_pausable === "1",
    is_mintable: entry.is_mintable === "1"
  };

  return { entry, signals };
}

// ---------------- MAIN CHECKER ----------------
export async function autoTaxHoneypotCheck(pairAddress) {
  const pair = normalize(pairAddress);
  if (!pair) throw new Error("Invalid pair address");

  const token = await resolveTokenFromPair(pair);
  if (!token) throw new Error("Pair does not contain WBNB or is invalid");

  const [hp, gp] = await Promise.all([
    checkHoneypotIs(token),
    checkGoPlusSecurity(token)
  ]);

  const safeByHp = hp.success && hp.sellTax !== null && hp.isHoneypot === false;
  const safeByGp = !gp.signals?.is_honeypot && !gp.signals?.cannot_sell_all && !gp.signals?.is_blacklisted;

  const verdict = {
    pair,
    token,

    honeypotIs: {
      buyTax: hp.buyTax,
      sellTax: hp.sellTax,
      transferTax: hp.transferTax,
      isHoneypot: hp.isHoneypot,
      raw: hp
    },

    goPlusSecurity: {
      signals: gp.signals,
      raw: gp.entry
    },

    safe: safeByHp && safeByGp
  };

  return verdict;
}

// ---------------- USAGE ----------------
(async () => {
  const PAIR = "0xYourPairAddressHere";
  const result = await autoTaxHoneypotCheck(PAIR);
  console.log(JSON.stringify(result, null, 2));
})();