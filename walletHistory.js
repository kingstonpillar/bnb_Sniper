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
  "0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8", // Unicrypt
  "0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21", // DxLocker
  "0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE", // PinkLock
  "0xe2fe530c047f2d85298b07d9333c05737f1435fb"  // Team Finance LP Locker
];

// ---------------- HELPERS ----------------
function normalize(addr) {
  try { return ethers.getAddress(addr?.trim()); } 
  catch { return null; }
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

// ---------------- ANTI-SELL SCAN ----------------
async function antiSellScan(token) {
  const t = normalize(token);
  if (!t) return { ok: false, flags: ["NO_BYTECODE"] };

  let bytecode;
  try {
    bytecode = await safeProviderCall(p => p.getCode(t));
  } catch {
    return { ok: false, flags: ["RPC_ERROR"] };
  }

  if (!bytecode || bytecode === "0x") return { ok: false, flags: ["NO_BYTECODE"] };

  const code = bytecode.toLowerCase();
  const flags = [];
  if (code.includes("tx.origin")) flags.push("TX_ORIGIN_USED");
  if (hasAny(code, ["revert", "invalid"])) flags.push("TRANSFER_REVERT_LOGIC");
  if (hasAny(code, ["uniswap", "pancake", "pair"])) flags.push("PAIR_REFERENCED");

  const hard = flags.filter(f => ["TX_ORIGIN_USED","TRANSFER_REVERT_LOGIC","PAIR_REFERENCED"].includes(f));
  return { ok: hard.length === 0, flags };
}

// ---------------- STATIC TAX CHECK ----------------
async function staticTaxCheck(token, tokenIn, factoryAddr) {
  const t = normalize(token);
  const tIn = normalize(tokenIn);
  const f = normalize(factoryAddr);
  if (!t || !tIn || !f) return { ok: false, reason: "CONFIG_ADDRESS_MISSING" };

  let pairAddress;
  try {
    pairAddress = await safeProviderCall(p => {
      const factory = new ethers.Contract(f, ["function getPair(address,address) view returns(address)"], p);
      return factory.getPair(t, tIn);
    });
  } catch {
    return { ok: false, reason: "RPC_ERROR" };
  }

  if (!pairAddress || pairAddress === ethers.ZeroAddress) return { ok: false, reason: "NO_PAIR" };

  let reserves, token0;
  try {
    ({ reserves, token0 } = await safeProviderCall(async p => {
      const pair = new ethers.Contract(
        pairAddress,
        ["function getReserves() view returns(uint112,uint112,uint32)", "function token0() view returns(address)"],
        p
      );
      return { reserves: await pair.getReserves(), token0: normalize(await pair.token0()) };
    }));
  } catch {
    return { ok: false, reason: "RPC_ERROR" };
  }

  const tokenReserve = BI(token0 === t ? reserves.reserve0 : reserves.reserve1);
  const tokenInReserve = BI(token0 === t ? reserves.reserve1 : reserves.reserve0);

  if (tokenReserve === 0n || tokenInReserve === 0n) return { ok: false, reason: "EMPTY_LP" };

  const ethIn = 10n ** 16n;
  const expectedBuyOut = biDiv(
    biMul(biMul(ethIn, tokenReserve), 9975n),
    biAdd(biMul(tokenInReserve, 10000n), biMul(ethIn, 9975n))
  );
  if (expectedBuyOut === 0n) return { ok: false, reason: "BUY_REVERT_OR_ZERO" };

  const buyTaxPercent = biPct(biSub(biMul(ethIn, tokenReserve), expectedBuyOut), biMul(ethIn, tokenReserve));
  if (buyTaxPercent >= 10n) return { ok: false, reason: `BUY_TAX_HIGH_${biStr(buyTaxPercent)}%` };

  const expectedSellOut = biDiv(
    biMul(biMul(expectedBuyOut, tokenInReserve), 9975n),
    biAdd(biMul(tokenReserve, 10000n), biMul(expectedBuyOut, 9975n))
  );
  if (expectedSellOut === 0n) return { ok: false, reason: "SELL_REVERT_100_PERCENT" };

  const sellTaxPercent = biPct(biSub(expectedBuyOut, expectedSellOut), expectedBuyOut);
  if (sellTaxPercent !== 0n) return { ok: false, reason: `SELL_TAX_NOT_ZERO_${biStr(sellTaxPercent)}%` };

  return { ok: true, buyTaxPercent: Number(buyTaxPercent), sellTaxPercent: 0 };
}

// ---------------- LP OWNER BEHAVIOR ----------------
export async function checkLpOwnerBehavior(tokenAddress) {
  const token = normalize(tokenAddress);
  if (!token) throw new Error("Invalid token");

  // Step A: Get LP token for pair
  let lpAddress;
  try {
    lpAddress = await safeProviderCall(() => {
      const factory = new ethers.Contract(
        FACTORY_ADDRESS,
        ["function getPair(address,address) view returns(address)"],
        provider
      );
      return factory.getPair(token, WBNB_ADDRESS);
    });
  } catch (err) {
    return { error: "RPC_ERROR", details: err.message };
  }

  if (!lpAddress || lpAddress === ethers.ZeroAddress) return { error: "NO_PAIR_FOUND" };

  const lp = new ethers.Contract(
    lpAddress,
    [
      "function totalSupply() view returns(uint256)",
      "function balanceOf(address) view returns(uint256)",
      "function owner() view returns(address)",
      "function hasRole(bytes32,address) view returns(bool)"
    ],
    provider
  );

  // Step B: Identify privileged addresses
  let deployer;
  try { deployer = await safeProviderCall(() => lp.owner?.()); } catch { deployer = null; }

  const totalLP = await safeProviderCall(() => lp.totalSupply());
  const privilegedAddrs = [deployer, ...KNOWN_LOCKERS].filter(Boolean);

  // Privileged LP
  let privilegedLP = 0n;
  for (const addr of privilegedAddrs) {
    const balance = await safeProviderCall(() => lp.balanceOf(addr));
    privilegedLP += balance;
  }

  // Burned LP
  const burnedLP = await safeProviderCall(() => lp.balanceOf(BURN_ADDRESS));

  // Step C: Unknown LP check
  const unknownLP_privileged = totalLP - privilegedLP;
  const unknownLP_burned = totalLP - burnedLP;

  let verdict = "SAFE";

  // Step D: Mintable check
  let mintable = false;
  try {
    const MINTER_ROLE = ethers.utils.id("MINTER_ROLE");
    if (lp.hasRole && deployer) mintable = await safeProviderCall(() => lp.hasRole(MINTER_ROLE, deployer));
  } catch { mintable = false; }

  // Step E: Risk scoring
  if (mintable || unknownLP_privileged > 0n || unknownLP_burned > 0n) verdict = "RUG_RISK";
  else if (privilegedLP * 100n / totalLP > 10n) verdict = "HIGH_RISK";

  const privilegedPercent = Number(privilegedLP * 10000n / totalLP) / 100;
  const burnedPercent = Number(burnedLP * 10000n / totalLP) / 100;

  return {
    lpAddress,
    totalLP: totalLP.toString(),
    privilegedLPPercent: privilegedPercent,
    burnedLPPercent: burnedPercent,
    unknownLPFromPrivileged: unknownLP_privileged.toString(),
    unknownLPFromBurned: unknownLP_burned.toString(),
    mintable,
    verdict
  };
}

// ---------------- WALLET RATE ----------------
export async function walletRate(token) {
  const details = {};
  let score = 0;

  // ---------------- ANTI-SELL SCAN ----------------
  const antiSell = await antiSellScan(token);
  details.antiSell = antiSell;
  if (!antiSell.ok) {
    return { token, totalScore: "0", health: "unhealthy", details };
  }
  score += 30; // leave room for LP owner

  // ---------------- STATIC TAX CHECK ----------------
  const tax = await staticTaxCheck(token, WBNB_ADDRESS, FACTORY_ADDRESS);
  details.taxCheck = tax;
  if (!tax.ok) {
    return { token, totalScore: score.toString(), health: "unhealthy", details };
  }
  score += 30;

  // ---------------- LP OWNER BEHAVIOR ----------------
  const lpOwner = await checkLpOwnerBehavior(token);
  details.lpOwner = lpOwner;

  // LP owner scoring
  if (lpOwner.verdict === "SAFE") {
    score += 40;
  } else {
    // Any RUG_RISK immediately kills total score
    score = 0;
  }

  return {
    token,
    totalScore: score.toString(),
    health: score >= 80 ? "healthy" : "unhealthy",
    details
  };
}