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
function normalize(addr) {
  try {
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
}

async function safeCall(fn) {
  let lastErr;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (e) {
      lastErr = e;
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
      console.log("Switched RPC:", RPC_URLS[rpcIndex]);
    }
  }
  throw lastErr;
}

// ---------------- TOKEN RESOLUTION FROM PAIR ----------------
async function resolveTokenFromPair(pairAddress) {
  const p = normalize(pairAddress);
  if (!p) return null;

  return safeCall(async (prov) => {
    const pair = new ethers.Contract(
      p,
      ["function token0() view returns(address)", "function token1() view returns(address)"],
      prov
    );

    let t0 = normalize(await pair.token0());
    let t1 = normalize(await pair.token1());
    let wbnb = normalize(WBNB);

    if (t0 === wbnb) return t1;
    if (t1 === wbnb) return t0;

    // fallback: token0
    return t0;
  });
}

// ---------------- PROXY DETECTION ----------------
async function detectProxy(token) {
  const IMPLEMENTATION_SLOT =
    "0x360894A13BA1A3210667C828492DB98DCA3E2076"; // EIP-1967

  const bytecode = await provider.getCode(token);

  if (bytecode.length <= 100) {
    // Most proxies have short bytecode
    try {
      const raw = await provider.getStorageAt(token, IMPLEMENTATION_SLOT);
      const impl = ethers.getAddress("0x" + raw.slice(-40));
      return { isProxy: true, implementation: impl };
    } catch {
      return { isProxy: true, implementation: token };
    }
  }

  return { isProxy: false, implementation: token };
}

// ---------------- STATIC ANTI-SELL SCAN ----------------
async function staticAntiSellScan(tokenAddress) {
  const { isProxy, implementation } = await detectProxy(tokenAddress);
  const bytecode = await provider.getCode(implementation);

  if (!bytecode || bytecode === "0x") {
    return { ok: false, reason: "NO_BYTECODE" };
  }

  const code = bytecode.toLowerCase();
  const flags = [];

  // --- detect restrictions ---
  const restrictedPatterns = [
    "blacklist",
    "isblacklisted",
    "cooldown",
    "maxtx",
    "maxwallet",
    "tradingenabled",
    "tradingactive"
  ];
  if (restrictedPatterns.some(k => code.includes(k))) {
    flags.push("TRANSFER_RESTRICTION_LOGIC");
  }

  if (code.includes("tx.origin")) {
    flags.push("TX_ORIGIN_USED");
  }

  const privileged = [
    "whitelist",
    "iswhitelisted",
    "excludedfromfee",
    "onlyowner",
    "onlyadmin"
  ];
  if (privileged.some(k => code.includes(k))) {
    flags.push("PRIVILEGED_WALLETS");
  }

  return {
    token: tokenAddress,
    scannedAddress: implementation,
    isProxy,
    ok: flags.length === 0,
    flags
  };
}

// ---------------- MAIN: ANTISELL BY PAIR ----------------
export async function antiSellScanByPair(pairAddress) {
  const token = await resolveTokenFromPair(pairAddress);
  if (!token) return { ok: false, reason: "PAIR_INVALID" };

  return staticAntiSellScan(token);
}

// ---------------- QUICK TEST ----------------
(async () => {
  const pair = "0x74471cde9b16f67a540112ea24844924a75220b0";
  const result = await antiSellScanByPair(pair);
  console.log(result);
})();

// ===============================================
// 🔷 LP OWNERSHIP CHECK — STRICT PASS/FAIL
// ===============================================
export async function lpOwnershipScore(pairAddress) {
  const lp = new ethers.Contract(pairAddress, ERC20_ABI, provider);

  const totalLP = await lp.totalSupply();
  const burnedLP = await lp.balanceOf(BURN_ADDRESS);

  let lockedLP = 0n;
  for (const locker of KNOWN_LOCKERS) {
    try { lockedLP += BigInt(await lp.balanceOf(locker)); } catch {}
  }

  if (lockedLP > totalLP) lockedLP = totalLP;

  const burnPercent = Number((burnedLP * 10000n) / totalLP) / 100;
  const lockPercent = Number((lockedLP * 10000n) / totalLP) / 100;

  const ok = burnPercent === 100 || lockPercent === 100;
  const reason = ok ? [] : ["LP still controlled by owner"];

  return {
    ok,
    reason,
    raw: {
      totalLP: totalLP.toString(),
      burnedLP: burnedLP.toString(),
      lockedLP: lockedLP.toString(),
      burnPercent,
      lockPercent
    }
  };
}

// ===============================================
// 🔷 MINTABILITY CHECK — STRICT PASS/FAIL
// ===============================================
export async function mintScore(tokenAddress) {
  let ok = true;
  const reason = [];

  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const MINTER_ROLE = ethers.id("MINTER_ROLE");

    // Check MINTER_ROLE
    if (token.hasRole) {
      try {
        const has = await token.hasRole(MINTER_ROLE, tokenAddress);
        if (has) {
          ok = false;
          reason.push("MINTER_ROLE assigned to token address");
        }
      } catch {}
    }

    // mint() opcode detection
    const code = await provider.getCode(tokenAddress);
    if (code.includes("40c10f19")) {
      ok = false;
      reason.push("mint() function present");
    }

  } catch {
    ok = false;
    reason.push("Contract unreadable, assuming mintable");
  }

  return { ok, reason };
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

// ===============================================
// 🔥 FINAL WALLET RATE — STRICT PASS/FAIL (4 × 25)
// ===============================================
export async function walletRate(pairAddress) {
  const details = {};

  // 1️⃣ Anti-Sell Scan
  details.antiSell = await antiSellScanByPair(pairAddress);
  if (!details.antiSell.ok) details.antiSell.reason = details.antiSell.flags || ["ANTI_SELL_DETECTED"];

  // 2️⃣ Static Tax Check
  details.taxCheck = await staticTaxCheck(pairAddress);
  if (!details.taxCheck.ok && !details.taxCheck.reason) details.taxCheck.reason = ["TAX_CHECK_FAILED"];

  // 3️⃣ LP Owner Control
  const lpOwnerRaw = await checkLpOwnerBehavior(pairAddress);
  details.lpOwner = {
    ok: lpOwnerRaw.verdict === "NO_OWNER_CONTROL",
    reason: lpOwnerRaw.verdict !== "NO_OWNER_CONTROL" ? ["Owner has LP control"] : []
  };

  // 4️⃣ Mintability Check
  const token = await resolveTokenFromPair(pairAddress);
  details.mintCheck = token
    ? await mintScore(token)
    : { ok: false, reason: ["Cannot resolve token from pair"] };

  // ✅ Final health calculation: pass only if all checks ok
  const allOk = details.antiSell.ok && details.taxCheck.ok && details.lpOwner.ok && details.mintCheck.ok;
  const totalScore = allOk ? 80 : 0;
  const health = allOk ? "HEALTHY" : "UNHEALTHY";

  return {
    pairAddress,
    totalScore,
    health,
    details
  };
}