// file: autoTaxHoneypotChecker.js
import "dotenv/config";
import { ethers } from "ethers";
import fetch from "node-fetch";

const RPC_URLS = [
  process.env.RPC_URL_8 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_9 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs available");

const provider = new ethers.JsonRpcProvider(RPC_URLS[0]);

// BSC WBNB (normalized)
// IMPORTANT: your .env uses WBNB_ADDRESS, not WBNB
const WBNB = (process.env.WBNB_ADDRESS || "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c").toLowerCase();

// Honeypot.is API (free)
const HONEYPOT_API = "https://api.honeypot.is/v2/IsHoneypot";

// GoPlus Token Security API (no key required for this endpoint)
const GOPLUS_SECURITY_API = "https://api.gopluslabs.io/api/v1/token_security";

// ---------------- ABI ----------------
const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];

// ---------------- HELPERS ----------------
async function safeFetchJson(url) {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalize(address) {
  try {
    return ethers.getAddress(String(address || "")).toLowerCase();
  } catch {
    return null;
  }
}

// ---------------- PAIR -> TOKEN ----------------
async function resolveTokenFromPair(pairAddress) {
  const p = normalize(pairAddress);
  if (!p) return null;

  const pair = new ethers.Contract(p, PAIR_ABI, provider);

  try {
    const t0 = normalize(await pair.token0());
    const t1 = normalize(await pair.token1());
    if (!t0 || !t1) return null;

    if (t0 === WBNB) return t1;
    if (t1 === WBNB) return t0;
  } catch {
    // ignore
  }

  return null;
}

// ---------------- Honeypot.is Free API ----------------
async function checkHoneypotIs(token) {
  const url = `${HONEYPOT_API}?address=${token}&chainID=56`;
  const data = await safeFetchJson(url);

  const result = data?.honeypotResult || {};
  return {
    success: Boolean(data?.honeypotResult),
    isHoneypot: Boolean(result.isHoneypot),
    buyTax: typeof result.buyTax === "number" ? result.buyTax : null,
    sellTax: typeof result.sellTax === "number" ? result.sellTax : null,
    transferTax: typeof result.transferTax === "number" ? result.transferTax : null,
    raw: data
  };
}

// ---------------- GoPlus API (correct endpoint) ----------------
async function checkGoPlusSecurity(token) {
  const t = normalize(token);
  if (!t) return { error: "TOKEN_INVALID" };

  // BSC chain_id = 56
  const url = `${GOPLUS_SECURITY_API}/56?contract_addresses=${t}`;
  const data = await safeFetchJson(url);

  // GoPlus commonly returns: { code, message, result: { [address]: {...} } }
  const entry =
    data?.result?.[t] ||
    data?.result?.[t.toLowerCase()] ||
    null;

  if (!entry) {
    return { error: "NO_DATA_FROM_GOPLUS", raw: data };
  }

  const signals = {
    is_honeypot: entry.is_honeypot === "1",
    cannot_sell_all: entry.cannot_sell_all === "1",
    is_blacklisted: entry.is_blacklisted === "1",
    transfer_pausable: entry.transfer_pausable === "1",
    is_mintable: entry.is_mintable === "1",
    owner_change_balance: entry.owner_change_balance === "1",
    hidden_owner: entry.hidden_owner === "1"
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

  // If GoPlus fails, keep it strict (safeByGp=false) as you coded
  const safeByGp = gp.error
    ? false
    : !gp.signals?.is_honeypot &&
      !gp.signals?.cannot_sell_all &&
      !gp.signals?.is_blacklisted;

  return {
    pair,
    token,
    honeypotIs: {
      buyTax: hp.buyTax,
      sellTax: hp.sellTax,
      transferTax: hp.transferTax,
      isHoneypot: hp.isHoneypot,
      raw: hp.raw
    },
    goPlusSecurity: {
      signals: gp.signals || null,
      raw: gp.entry || null,
      error: gp.error || null
    },
    safe: safeByHp && safeByGp
  };
}