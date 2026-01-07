import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";
import {
  BI,
  biMul,
  biDiv,
  biSub,
  biAdd,
  biPct,
  biStr
} from "./bigintSafe.js";

// ---------------- CONFIG ----------------
const RPC_URLS = [
  process.env.RPC_URL_8 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_9 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (RPC_URLS.length === 0) throw new Error("No RPC URLs available");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 2 });

const FACTORY_ADDRESS = process.env.PANCAKE_FACTORY;
const WBNB_ADDRESS = process.env.WBNB_ADDRESS;
const KNOWN_LOCKERS = [
  "0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8",
  "0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21",
  "0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE",
  "0xe2fe530c047f2d85298b07d9333c05737f1435fb"
];

export const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function hasRole(bytes32 role, address account) view returns (bool)"
];

export const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

// ---------------- HELPERS ----------------
function safeNormalize(addr) {
  try {
    return ethers.getAddress(addr?.trim());
  } catch {
    return null;
  }
}

async function safeProviderCall(fn) {
  let lastErr;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      lastErr = err;
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
      console.warn("Switched RPC to:", RPC_URLS[rpcIndex]);
    }
  }
  throw lastErr;
}

function hasAny(str, patterns) {
  return patterns.some(p => str.includes(p));
}

// ---------------- TOKEN RESOLUTION ----------------
async function getTradeTokenFromPair(pairAddress) {
  const normalizedPair = safeNormalize(pairAddress);
  if (!normalizedPair) return null;

  return safeProviderCall(async (p) => {
    const pair = new ethers.Contract(
      normalizedPair,
      ["function token0() view returns(address)", "function token1() view returns(address)"],
      p
    );
    const t0 = safeNormalize(await pair.token0());
    const t1 = safeNormalize(await pair.token1());
    const wbnb = safeNormalize(WBNB_ADDRESS);

    if (t0 === wbnb) return t1;
    if (t1 === wbnb) return t0;
    return t0; // fallback
  });
}

// ---------------- ANTI-SELL / HONEYPOT ----------------
async function antiSellScanToken(tokenAddress) {
  const t = safeNormalize(tokenAddress);
  if (!t) return { ok: false, flags: ["INVALID_TOKEN_ADDRESS"] };

  let code;
  try {
    code = await safeProviderCall(p => p.getCode(t));
  } catch {
    return { ok: false, flags: ["RPC_ERROR"] };
  }

  if (!code || code === "0x") return { ok: false, flags: ["NO_BYTECODE"] };

  const c = code.toLowerCase();
  const flags = [];

  if (c.includes("tx.origin")) flags.push("TX_ORIGIN_USED");
  if (hasAny(c, ["blacklist", "isblacklisted", "cooldown", "cooldownenabled", "maxwallet", "maxtx", "tradingenabled", "tradingactive", "onlyowner", "onlyadmin"])) {
    flags.push("TRANSFER_RESTRICTION_LOGIC");
  }
  if (hasAny(c, ["whitelist", "iswhitelisted", "excludedfromfee"])) flags.push("PRIVILEGED_SELLERS");

  const hard = flags.filter(f => ["TX_ORIGIN_USED","TRANSFER_RESTRICTION_LOGIC","PRIVILEGED_SELLERS"].includes(f));

  return { ok: hard.length === 0, flags };
}

async function antiSellScanByPair(pairAddress) {
  const token = await getTradeTokenFromPair(pairAddress);
  return antiSellScanToken(token);
}

// ---------------- STATIC TAX CHECK ----------------
async function staticTaxCheck(pairAddress) {
  const pAddr = safeNormalize(pairAddress);
  if (!pAddr) return { ok: false, reason: "INVALID_PAIR_ADDRESS" };

  let reserves, token0, token1;
  try {
    ({ reserves, token0, token1 } = await safeProviderCall(async (p) => {
      const pair = new ethers.Contract(pAddr, ERC20_ABI, p);
      return {
        reserves: await pair.getReserves(),
        token0: safeNormalize(await pair.token0()),
        token1: safeNormalize(await pair.token1())
      };
    }));
  } catch {
    return { ok: false, reason: "RPC_ERROR" };
  }

  let tokenReserve = 0n, wbnbReserve = 0n;
  const WBNB = safeNormalize(WBNB_ADDRESS);
  const ZERO = "0x0000000000000000000000000000000000000000";

  if (token0 === WBNB) { wbnbReserve = BI(reserves.reserve0); tokenReserve = BI(reserves.reserve1); }
  else if (token1 === WBNB) { wbnbReserve = BI(reserves.reserve1); tokenReserve = BI(reserves.reserve0); }
  else if (![token0, token1].includes(WBNB) && ![token0, token1].includes(ZERO)) {
    return { ok: false, reason: "NO_WBNB_PAIR" };
  }

  if (tokenReserve === 0n || wbnbReserve === 0n) return { ok: false, reason: "EMPTY_LP" };

  const ethIn = 10n ** 16n; // 0.01 BNB
  const FEE = 9975n, BASE = 10000n;

  const expectedBuyOut = biDiv(biMul(biMul(ethIn, tokenReserve), FEE), biAdd(biMul(wbnbReserve, BASE), biMul(ethIn, FEE)));
  if (expectedBuyOut === 0n) return { ok: false, reason: "BUY_REVERT_OR_ZERO" };

  const expectedBuyNoTax = biDiv(biMul(ethIn, tokenReserve), biAdd(wbnbReserve, ethIn));
  const buyTaxPercent = biPct(biSub(expectedBuyNoTax, expectedBuyOut), expectedBuyNoTax);
  if (buyTaxPercent >= 10n) return { ok: false, reason: `BUY_TAX_HIGH_${biStr(buyTaxPercent)}%` };

  const expectedSellNoTax = biDiv(biMul(expectedBuyOut, wbnbReserve), biAdd(tokenReserve, expectedBuyOut));
  const expectedSellOut = biDiv(biMul(biMul(expectedBuyOut, wbnbReserve), FEE), biAdd(biMul(tokenReserve, BASE), biMul(expectedBuyOut, FEE)));

  if (expectedSellOut === 0n) return { ok: false, reason: "SELL_REVERT_100_PERCENT" };
  if (expectedSellOut < expectedSellNoTax) return { ok: false, reason: "SELL_TAX_NOT_ZERO" };

  return { ok: true, buyTaxPercent: Number(buyTaxPercent), sellTaxPercent: 0 };
}

// ---------------- LP OWNER BEHAVIOR ----------------
async function canMint(lp) {
  try {
    const MINTER_ROLE = ethers.id("MINTER_ROLE");
    for (const addr of KNOWN_LOCKERS) if (lp.hasRole && await lp.hasRole(MINTER_ROLE, addr)) return true;
    const code = await provider.getCode(lp.address);
    if (code.includes("40c10f19")) return true;
  } catch { return true; } // conservative
  return false;
}

export async function checkLpOwnerBehavior(pairAddress) {
  const lp = await safeProviderCall(p => new ethers.Contract(pairAddress, ERC20_ABI, p));
  const totalLP = await lp.totalSupply();
  const burnedLP = await lp.balanceOf(BURN_ADDRESS);

  let lockedLP = 0n;
  for (const locker of KNOWN_LOCKERS) {
    try { lockedLP += BI(await safeProviderCall(p => new ethers.Contract(lp.address, ERC20_ABI, p).balanceOf(locker))); } catch {}
  }
  if (lockedLP > totalLP) lockedLP = totalLP;

  const mintable = await canMint(lp);
  const BURN_THRESHOLD = (totalLP * 80n) / 100n;
  const LOCK_THRESHOLD = (totalLP * 80n) / 100n;
  const sufficientlyBurned = burnedLP >= BURN_THRESHOLD;
  const sufficientlyLocked = lockedLP >= LOCK_THRESHOLD;

  if ((sufficientlyBurned || sufficientlyLocked) && !mintable) {
    return { verdict: "NO_OWNER_CONTROL", totalLP: totalLP.toString(), burnedLP: burnedLP.toString(), lockedLP: lockedLP.toString(), mintable };
  }

  return { verdict: "OWNER_HAS_CONTROL", totalLP: totalLP.toString(), burnedLP: burnedLP.toString(), lockedLP: lockedLP.toString(), mintable };
}

// ---------------- WALLET SCANNER ----------------
export async function walletRate(pairAddress) {
  const details = {};
  let totalScore = 100;

  details.antiSell = await antiSellScanByPair(pairAddress);
  details.taxCheck = await staticTaxCheck(pairAddress);
  details.lpOwner = await checkLpOwnerBehavior(pairAddress);

  console.log("LP OWNER DETAILS:", details.lpOwner);

  if (!details.antiSell.ok) totalScore = 0;
  if (!details.taxCheck.ok || (details.taxCheck.buyTaxPercent ?? 0) >= 10) totalScore = 0;
  if (details.lpOwner.verdict !== "NO_OWNER_CONTROL") totalScore = 0;

  const health = totalScore >= 80 ? "HEALTHY " : "UNHEALTHY ";

  return { pairAddress, totalScore: totalScore.toString(), health, details };
}