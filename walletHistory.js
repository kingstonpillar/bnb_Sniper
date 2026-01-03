import { ethers } from "ethers";
import PQueue from "p-queue";
import {
  BI,
  biMul,
  biDiv,
  biSub,
  biPct,
  biStr
} from "./bigintSafe.js";

// ---------------- CONFIG ----------------
const RPC_URLS = [
  process.env.RPC_URL_8 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_9 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 2 });

// ---------------- HELPERS ----------------
function normalize(addr) {
  try { return ethers.getAddress(addr?.trim()); } 
  catch { return null; }
}

async function safeProviderCall(fn) {
  let lastErr;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try { return await rpcQueue.add(() => fn(provider)); } 
    catch (err) { lastErr = err; rpcIndex = (rpcIndex + 1) % RPC_URLS.length; provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]); }
  }
  throw lastErr;
}

function hasAny(str, patterns) { return patterns.some(p => str.includes(p)); }

// ---------------- ANTI-SELL SCAN ----------------
async function antiSellScan(token) {
  const t = normalize(token); // internal normalization
  const bytecode = await safeProviderCall(p => p.getCode(t));
  if (!bytecode || bytecode === "0x") return { ok: false, flags: ["NO_BYTECODE"] };

  const code = bytecode.toLowerCase();
  const flags = [];

  // HARD BLOCKERS
  if (code.includes("tx.origin")) flags.push("TX_ORIGIN_USED");
  if (hasAny(code, ["revert", "invalid"])) flags.push("TRANSFER_REVERT_LOGIC");
  if (hasAny(code, ["uniswap", "pancake", "pair"])) flags.push("PAIR_REFERENCED");

  // SOFT TRAPS
  if (hasAny(code, ["block.number", "block.timestamp"])) flags.push("TIME_BASED_LOGIC");
  if (hasAny(code, ["blacklist", "whitelist"])) flags.push("LIST_BASED_CONTROL");
  if (hasAny(code, ["maxwallet", "maxtx"])) flags.push("TX_LIMITS");
  if (hasAny(code, ["onlyowner", "owner()"])) flags.push("OWNER_CONTROLLED");

  const hard = flags.filter(f => ["TX_ORIGIN_USED", "TRANSFER_REVERT_LOGIC", "PAIR_REFERENCED"].includes(f));

  return { ok: hard.length === 0, flags };
}

// ---------------- STATIC TAX CHECK ----------------
async function staticTaxCheck(token, tokenIn, factoryAddr) {
  const t = normalize(token), tIn = normalize(tokenIn), f = normalize(factoryAddr);
  const factory = new ethers.Contract(f, ["function getPair(address,address) view returns(address)"], provider);
  const pairAddress = await safeProviderCall(p => factory.getPair(t, tIn));
  if (!pairAddress || pairAddress === ethers.constants.AddressZero) return { ok: false, reason: "NO_PAIR" };

  const pair = new ethers.Contract(pairAddress, [
    "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
    "function token0() view returns (address)",
  ], provider);

  const reserves = await safeProviderCall(p => pair.getReserves());
  const token0 = normalize(await safeProviderCall(p => pair.token0()));

  const tokenReserve = BI(token0 === t ? reserves.reserve0 : reserves.reserve1);
  const tokenInReserve = BI(token0 === t ? reserves.reserve1 : reserves.reserve0);

  if (tokenReserve === 0n || tokenInReserve === 0n) return { ok: false, reason: "EMPTY_LP" };

  const ethIn = 10n ** 16n;
  const expectedBuyOut = biDiv(
    biMul(biMul(ethIn, tokenReserve), 9975n),
    biAdd(biMul(tokenInReserve, 10000n), biMul(ethIn, 9975n))
  );

  const buyTaxPercent = expectedBuyOut > 0n
    ? biPct(biSub(biMul(ethIn, tokenReserve), expectedBuyOut), biMul(ethIn, tokenReserve))
    : 0n;

  const expectedSellOut = biDiv(
    biMul(biMul(expectedBuyOut, tokenInReserve), 9975n),
    biAdd(biMul(tokenReserve, 10000n), biMul(expectedBuyOut, 9975n))
  );

  const sellTaxPercent = expectedBuyOut > 0n
    ? biPct(biSub(expectedBuyOut, expectedSellOut), expectedBuyOut)
    : 0n;

  if (buyTaxPercent > 10n) return { ok: false, reason: `BUY_TAX_HIGH_${biStr(buyTaxPercent)}%` };
  if (sellTaxPercent !== 0n) return { ok: false, reason: `SELL_TAX_NOT_ZERO_${biStr(sellTaxPercent)}%` };

  return { ok: true, buyTaxPercent: Number(buyTaxPercent), sellTaxPercent: Number(sellTaxPercent) };
}

// ---------------- WALLET RATE (TOKEN ONLY, OUTPUT ORIGINAL) ----------------
export async function walletRate(token) {
  const details = {};
  let score = 0;

  // Anti-sell scan
  const antiSell = await antiSellScan(token);
  details.antiSell = antiSell;
  if (!antiSell.ok) return { token, totalScore: "0", health: "unhealthy", details };

  score += 40;

  // Static tax check
  const tax = await staticTaxCheck(token, process.env.WBNB_ADDRESS, process.env.PANCAKE_FACTORY);
  details.taxCheck = tax;
  if (!tax.ok) return { token, totalScore: "40", health: "unhealthy", details };

  score += 40;
  const health = score >= 80 ? "healthy" : "unhealthy";

  return { token, totalScore: score.toString(), health, details };
}