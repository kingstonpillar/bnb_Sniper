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

export const ERC20_ABI = [
  // Standard ERC-20
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",

  // LP pair functions
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",

  // Optional: mint control
  "function hasRole(bytes32 role, address account) view returns (bool)"
];

export const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

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

// ---------------- TRADE TOKEN DETECTION FROM PAIR ----------------

async function getTradeTokenFromPair(pairAddress) {
  const pair = new ethers.Contract(
    pairAddress,
    [
      "function token0() view returns(address)",
      "function token1() view returns(address)"
    ],
    provider
  );

  const t0 = normalize(await pair.token0());
  const t1 = normalize(await pair.token1());

  if (t0 === normalize(WBNB_ADDRESS)) return t1;
  if (t1 === normalize(WBNB_ADDRESS)) return t0;

  // If neither side is WBNB, scan both later if you want
  return t0;
}

// ================= PAIR-BASED ANTI-SELL DETECTION (TOKEN RESOLUTION) =================
async function antiSellScanByPair(pairAddress) {
  const token = await getTradeTokenFromPair(pairAddress);
  return antiSellScanToken(token);
}

// ===================== PAIR-BASED ANTI-SELL DETECTION =====================
async function antiSellScanToken(tokenAddress) {
  const t = normalize(tokenAddress);
  if (!t) return { ok: false, flags: ["INVALID_TOKEN_ADDRESS"] };

  let bytecode;
  try {
    bytecode = await safeProviderCall(p => p.getCode(t));
  } catch {
    return { ok: false, flags: ["RPC_ERROR"] };
  }

  if (!bytecode || bytecode === "0x") {
    return { ok: false, flags: ["NO_BYTECODE"] };
  }

  const code = bytecode.toLowerCase();
  const flags = [];

  //  HIGH-RISK OWNER / HONEYPOT SIGNALS
  if (code.includes("tx.origin")) flags.push("TX_ORIGIN_USED");

  // Owner / transfer restrictions
  if (hasAny(code, [
    "blacklist",
    "isblacklisted",
    "cooldown",
    "cooldownenabled",
    "maxwallet",
    "maxtx",
    "tradingenabled",
    "tradingactive",
    "onlyowner",
    "onlyadmin"
  ])) flags.push("TRANSFER_RESTRICTION_LOGIC");

  // Conditional transfer revert detection (more precise)
  // Only trigger if transfer function has a require/revert AND a conditional on sender/recipient
  if (
    code.match(/function\s+transfer/) &&
    code.match(/require|revert/) &&
    code.match(/from|to|sender|recipient/)
  ) {
    flags.push("CONDITIONAL_TRANSFER_REVERT");
  }

  // Privileged accounts / whitelist bypass
  if (hasAny(code, ["whitelist", "iswhitelisted", "excludedfromfee"])) {
    flags.push("PRIVILEGED_SELLERS");
  }

  //  HARD FAIL FLAGS
  const hard = flags.filter(f =>
    [
      "TX_ORIGIN_USED",
      "TRANSFER_RESTRICTION_LOGIC",
      "CONDITIONAL_TRANSFER_REVERT",
      "PRIVILEGED_SELLERS"
    ].includes(f)
  );

  return {
    ok: hard.length === 0,
    flags
  };
}
// ---------------- STATIC TAX CHECK (pair-based) ----------------
async function staticTaxCheck(pairAddress) {
  const pAddr = normalize(pairAddress);
  if (!pAddr) return { ok: false, reason: "CONFIG_ADDRESS_MISSING" };

  let reserves, token0, token1;
  try {
    ({ reserves, token0, token1 } = await safeProviderCall(async p => {
      const pair = new ethers.Contract(
        pAddr,
        [
          "function getReserves() view returns(uint112,uint112,uint32)",
          "function token0() view returns(address)",
          "function token1() view returns(address)"
        ],
        p
      );
      const r = await pair.getReserves();
      return { reserves: r, token0: normalize(await pair.token0()), token1: normalize(await pair.token1()) };
    }));
  } catch {
    return { ok: false, reason: "RPC_ERROR" };
  }

  const tokenReserve = BI(reserves.reserve0);
  const tokenInReserve = BI(reserves.reserve1);

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
export async function checkLpOwnerBehavior(pairAddress) {
  const lp = new ethers.Contract(pairAddress, ERC20_ABI, provider);

  const totalLP = await lp.totalSupply();

  // Burn check
  const burnedLP = await lp.balanceOf(BURN_ADDRESS);

  // Known locker check
  let lockedLP = 0n;
  for (const locker of KNOWN_LOCKERS) {
  lockedLP += await lp.balanceOf(locker);
}
if (lockedLP > totalLP) lockedLP = totalLP;

  // Mint control
  const mintable = await canMint(lp);

  // OWNER BEHAVIOR VERDICT (80% THRESHOLD, NO MIXING)
const BURN_THRESHOLD = (totalLP * 80n) / 100n;
const LOCK_THRESHOLD = (totalLP * 80n) / 100n;

const sufficientlyBurned = burnedLP >= BURN_THRESHOLD;
const sufficientlyLocked = lockedLP >= LOCK_THRESHOLD;

if ((sufficientlyBurned || sufficientlyLocked) && !mintable) {
  return {
    verdict: "NO_OWNER_CONTROL",
    totalLP: totalLP.toString(),
    burnedLP: burnedLP.toString(),
    lockedLP: lockedLP.toString(),
    mintable
  };
}

return {
  verdict: "OWNER_HAS_CONTROL",
  totalLP: totalLP.toString(),
  burnedLP: burnedLP.toString(),
  lockedLP: lockedLP.toString(),
  mintable
};
}
// ---------------- HELPER ----------------
async function canMint(lp) {
  try {
    const MINTER_ROLE = ethers.id("MINTER_ROLE");

    for (const addr of KNOWN_LOCKERS) {
      if (lp.hasRole && await lp.hasRole(MINTER_ROLE, addr)) return true;
    }

    // Bytecode selector check (mint(address,uint256))
    const code = await provider.getCode(lp.address);
    if (code.includes("40c10f19")) return true;

  } catch {
    return true; // conservative: assume mintable if uncertain
  }
  return false;
}

// ===================== WALLET RATE SCANNER (STRICT TOTAL SCORE) =====================
export async function walletRate(pairAddress) {
  const details = {};
  let totalScore = 100; // start full, deduct if any fail

  // ---------------- ANTI-SELL SCAN ----------------
  const antiSell = await antiSellScanByPair(pairAddress);
  details.antiSell = antiSell;

  if (!antiSell.ok) {
    totalScore = 0;
    return {
      pairAddress,
      totalScore: totalScore.toString(),
      health: "unhealthy",
      details
    };
  }

  // ---------------- STATIC TAX CHECK ----------------
  const tax = await staticTaxCheck(pairAddress);
  details.taxCheck = tax;

  if (!tax.ok || tax.buyTaxPercent >= 10) {
    totalScore = 0;
    return {
      pairAddress,
      totalScore: totalScore.toString(),
      health: "unhealthy",
      details
    };
  }

  // ---------------- LP OWNER BEHAVIOR ----------------
  const lpOwner = await checkLpOwnerBehavior(pairAddress);
  details.lpOwner = lpOwner;

  if (lpOwner.verdict !== "NO_OWNER_CONTROL") {
    totalScore = 0;
    return {
      pairAddress,
      totalScore: totalScore.toString(),
      health: "unhealthy",
      details
    };
  }

  // All checks passed  healthy, full score
  return {
    pairAddress,
    totalScore: totalScore.toString(), // always 100 if fully clean
    health: "healthy",
    details
  };
}