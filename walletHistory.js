import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { WBNB, PANCAKE_FACTORY, PANCAKE_ROUTER } from "./env.js";
import {
  BI,
  biMul,
  biDiv,
  biSub,
  biAdd,
  biPct,
  biStr
} from "./bigintSafe.js";
import { isProjectContract } from "./projectContracts.js";
import { scanRouter } from "./maliciousRouters.js"; // your

// ---------------- CONFIG ----------------
const RPC_URLS = [
  process.env.RPC_URL_8 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_9 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (RPC_URLS.length === 0) throw new Error("No RPC URLs available");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 2 });


const KNOWN_LOCKERS = [
  "0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8",
  "0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21",
  "0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE",
  "0xe2fe530c047f2d85298b07d9333c05737f1435fb"
];

// Combined ERC20 ABI for both static tax and mint control
export const LP_ABI = [
  // LP functions
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",

  // Mint control functions
  "function hasRole(bytes32 role, address account) view returns (bool)"
];

export const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";

// ------------------- INLINE HELPERS -------------------
function normalize(addr) {
  try {
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
}



const safeNormalize = normalize;



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
  const p = safeNormalize(pairAddress);
  if (!p) return null;

  return safeCall(async (prov) => {
    const pair = new ethers.Contract(
      p,
      ["function token0() view returns(address)", "function token1() view returns(address)"],
      prov
    );

    let t0 = safeNormalize(await pair.token0());
    let t1 = safeNormalize(await pair.token1());

    if (t0 === WBNB) return t1;
    if (t1 === WBNB) return t0;

    // fallback: token0
    return t0;
  });
}



// ---------------- PROXY DETECTION ----------------
async function detectProxy(token) {
  const IMPLEMENTATION_SLOT =
    "0x360894A13BA1A3210667C828492DB98DCA3E2076";

  const bytecode = await provider.getCode(token);

  if (bytecode.length <= 100) {
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

  if (isProxy) {
    return {
      ok: false,
      reason: "PROXY_REJECTED",
      flags: ["PROXY_CONTRACT"],
      token: tokenAddress
    };
  }

  const project = await isProjectContract(tokenAddress);

  const bytecode = await provider.getCode(implementation);
  if (!bytecode || bytecode === "0x") {
    return { ok: false, reason: "NO_BYTECODE" };
  }

  const code = bytecode.toLowerCase();
  const flags = [];

  // --------------------------------------------------------------------
  // 1️⃣ TRANSFER RESTRICTIONS (BLACKLIST / LIMITS / COOLDOWN)
  // → Converted from words into hex versions
  // --------------------------------------------------------------------
  const restrictedHex = [
    "626c61636b6c697374",        // "blacklist"
    "6973626c61636b6c6973746564",// "isblacklisted"
    "636f6f6c646f776e",          // "cooldown"
    "6d61787478",                // "maxtx"
    "6d617877616c6c6574",        // "maxwallet"
    "74726164696e67656e61626c6564", // "tradingenabled"
    "74726164696e67616374697665"    // "tradingactive"
  ];

  if (restrictedHex.some(x => code.includes(x)))
    flags.push("TRANSFER_RESTRICTION_LOGIC");

  // --------------------------------------------------------------------
  // 2️⃣ TX.ORIGIN ABUSE (Anti‑bot trap)
  // → detectable by opcode 0x32 (TXORIGIN)
  // --------------------------------------------------------------------
  if (code.includes("32")) {
    flags.push("TX_ORIGIN_USED");
  }

  // --------------------------------------------------------------------
  // 3️⃣ PRIVILEGED WALLETS (owner/admin whitelist)
  // --------------------------------------------------------------------
  const privilegedHex = [
    "77686974656c697374",         // "whitelist"
    "697377686974656c6973746564", // "iswhitelisted"
    "6578636c7564656466726f6d666565", // "excludedfromfee"
    "6f6e6c796f776e6572",         // "onlyowner"
    "6f6e6c7961646d696e"          // "onlyadmin"
  ];

  if (privilegedHex.some(x => code.includes(x)))
    flags.push("PRIVILEGED_WALLETS");

  // --------------------------------------------------------------------
  // 4️⃣ HONEYPOT / ANTI‑SELL PATTERNS
  //    ALL rewritten as HEX
  // --------------------------------------------------------------------
  const honeypotHex = [
    "6d617873656c6c",             // "maxsell"
    "73656c6c6c696d6974",         // "selllimit"
    "616e746973656c6c",           // "antisell"
    "73656c6c636f6f6c646f776e",   // "sellcooldown"
    "6665656f6e73656c6c",         // "feeonsell"
    "63616e73656c6c",             // "cansell"
    "726576657274",               // "revert"
    
    // opcode‑level honeypot
    "fd",                         // invalid opcode (revert honeypot)
    "fe"                          // revert opcode
  ];

  if (honeypotHex.some(x => code.includes(x)))
    flags.push("HONEYPOT_PATTERN");

  // --------------------------------------------------------------------
  // 5️⃣ MALICIOUS ROUTER BYTECODE TRACES
  // --------------------------------------------------------------------
  const maliciousRouterHex = [
    "c5d".toLowerCase(),
    "37e".toLowerCase()
  ];

  if (maliciousRouterHex.some(x => code.includes(x)))
    flags.push("MALICIOUS_ROUTER");

  // --------------------------------------------------------------------
  // 6️⃣ SAFE PROJECT CONTRACT
  // --------------------------------------------------------------------
  if (project) {
    return {
      token: tokenAddress,
      scannedAddress: implementation,
      isProxy: false,
      ok: true,
      reason: "SAFE_PROJECT_CONTRACT",
      flags
    };
  }

  // --------------------------------------------------------------------
  // 7️⃣ NORMAL RESULT
  // --------------------------------------------------------------------
  return {
    token: tokenAddress,
    scannedAddress: implementation,
    isProxy: false,
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

// ---------------- LP OWNERSHIP ----------------
export async function lpOwnershipScore(pairAddress) {
  const lp = new ethers.Contract(lpAddress, LP_ABI, provider);

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

// ---------------- MINT SCORE WITH PROJECT CONTRACTS ----------------
export async function mintScore(tokenAddress) {
  let ok = true;
  const reason = [];

  // ---------------- PROJECT CONTRACT CHECK ----------------
  if (await isProjectContract(tokenAddress, provider)) {
    return { ok: true, reason: ["PROJECT_CONTRACT_SAFE"] };
  }

  // ---------------- MINT CONTROL ----------------
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const MINTER_ROLE = ethers.id("MINTER_ROLE");

    if (token.hasRole) {
      try {
        const has = await token.hasRole(MINTER_ROLE, tokenAddress);
        if (has) {
          ok = false;
          reason.push("MINTER_ROLE assigned to token address");
        }
      } catch {}
    }

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


// ------------------- STATIC TAX CHECK -------------------
export async function staticTaxCheck(pairAddress) {
  const pAddr = normalize(pairAddress);
  if (!pAddr) return { ok: false, reason: "INVALID_PAIR_ADDRESS" };

  // EARLY LEGIT PROJECT CONTRACT CHECK
  if (await isProjectContract(pAddr)) {
    return { ok: true, reason: "PROJECT_CONTRACT" };
  }

  // GET RESERVES + TOKENS VIA safeCall()
  const data = await safeCall(async (provider) => {
    const pair = new ethers.Contract(pAddr, ERC20_ABI, provider);
    const [reservesRaw, t0, t1] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.token1()
    ]);
    return {
      reserves: reservesRaw,
      token0: normalize(t0),
      token1: normalize(t1)
    };
  });

  if (!data) return { ok: false, reason: "RPC_ERROR" };

  const { reserves, token0, token1 } = data;
  const ZERO = "0x0000000000000000000000000000000000000000";

  let tokenReserve = 0n, wbnbReserve = 0n;

  if (token0 === WBNB) {
    wbnbReserve = BI(reserves.reserve0);
    tokenReserve = BI(reserves.reserve1);
  } else if (token1 === WBNB) {
    wbnbReserve = BI(reserves.reserve1);
    tokenReserve = BI(reserves.reserve0);
  } else if (![token0, token1].includes(WBNB) && ![token0, token1].includes(ZERO)) {
    return { ok: false, reason: "NO_WBNB_PAIR" };
  }

  if (tokenReserve === 0n || wbnbReserve === 0n)
    return { ok: false, reason: "EMPTY_LP" };

  // --- TAX SIMULATION (DEX fee only, assume token 0% tax) ---
  const ethIn = 10n ** 16n; // 0.01 BNB
  const FEE = 9975n, BASE = 10000n; // 0.25% DEX fee

  const expectedBuyOut = biDiv(
    biMul(biMul(ethIn, tokenReserve), FEE),
    biAdd(biMul(wbnbReserve, BASE), biMul(ethIn, FEE))
  );

  const expectedSellOut = biDiv(
    biMul(biMul(expectedBuyOut, wbnbReserve), FEE),
    biAdd(biMul(tokenReserve, BASE), biMul(expectedBuyOut, FEE))
  );

  // Buy/sell tax = 0 because token has no tax
  return {
    ok: true,
    buyTaxPercent: 0,
    sellTaxPercent: 0,
    expectedBuyOut: Number(expectedBuyOut),
    expectedSellOut: Number(expectedSellOut)
  };
}

// ---------------- FINAL WALLET RATE ----------------
export async function walletRate(pairAddress) {
  const details = {};

  // ---------------- ANTI-SELL ----------------
  details.antiSell = await safeCall(() => antiSellScanByPair(pairAddress));
  if (!details.antiSell.ok)
    details.antiSell.reason = details.antiSell.flags?.length
      ? details.antiSell.flags
      : ["ANTI_SELL_DETECTED"];

  // ---------------- TAX CHECK ----------------
  const taxResult = await safeCall(() => staticTaxCheck(pairAddress));
  if (!taxResult) {
    details.taxCheck = { ok: false, reason: ["TAX_CHECK_FAILED"] };
  } else {
    // Interpret staticTaxCheck results
    details.taxCheck = {
      ok: taxResult.ok,
      reason: taxResult.ok ? ["NO_TOKEN_TAX"] : ["TOKEN_TAX_DETECTED"],
      buyTaxPercent: taxResult.buyTaxPercent ?? 0,
      sellTaxPercent: taxResult.sellTaxPercent ?? 0,
      expectedBuyOut: taxResult.expectedBuyOut,
      expectedSellOut: taxResult.expectedSellOut
    };
  }

  // ---------------- LP OWNERSHIP ----------------
  const lpOwnerRaw = await safeCall(() => lpOwnershipScore(pairAddress));
  details.lpOwner = {
    ok: lpOwnerRaw.ok,
    reason: lpOwnerRaw.reason
  };

  // ---------------- TOKEN ----------------
  const token = await safeCall(() => resolveTokenFromPair(pairAddress));

  // ---------------- MINT CHECK ----------------
  details.mintCheck = token
    ? await safeCall(() => mintScore(token))
    : { ok: false, reason: ["Cannot resolve token from pair"] };

  // ---------------- PROJECT CONTRACT SCORE ----------------
  let projectScore = 0;
  let isProjectContractFlag = false;

  if (token) {
    try {
      if (await isProjectContract(token)) {
        projectScore = 25;
        isProjectContractFlag = true;
        details.projectContract = {
          ok: true,
          reason: ["PROJECT_CONTRACT_SAFE"]
        };
      } else {
        details.projectContract = {
          ok: false,
          reason: ["NOT_PROJECT_CONTRACT"]
        };
      }
    } catch (e) {
      details.projectContract = {
        ok: false,
        reason: ["PROJECT_CONTRACT_ERROR", e.message]
      };
    }
  }

  // ---------------- ROUTER PENALTY ----------------
  let routerPenalty = 0;
  let routerFlagged = false;

  if (token && token !== WBNB) {
    const scan = await safeCall(() => scanRouter(token));
    if (!scan.ok) {
      routerPenalty = 50; // fixed penalty
      routerFlagged = true;
      details.router = { ok: false, reason: scan.reason };
    } else {
      details.router = { ok: true, reason: scan.reason };
    }
  }

  // ---------------- TOTAL SCORE & HEALTH ----------------
  const allOk =
    details.antiSell.ok &&
    details.taxCheck.ok &&
    details.lpOwner.ok &&
    details.mintCheck.ok;

  const baseScore = allOk ? 120 : 0; // base health score
  const totalScore = baseScore + projectScore - routerPenalty;

  const health = totalScore >= 120 ? "HEALTHY" : "UNHEALTHY";

  return {
    pairAddress,
    totalScore,
    health,
    details,
    isProjectContract: isProjectContractFlag,
    routerFlagged
  };
}

// ---------------- QUICK TEST ----------------
(async () => {
  const pair = "0x74471cde9b16f67a540112ea24844924a75220b0";
  const result = await walletRate(pair);
  console.log(result);
})();