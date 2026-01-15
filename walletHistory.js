// file: walletHistory.js
// NOTE: Static risk screen only.

import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { WBNB as ENV_WBNB, PANCAKE_FACTORY as ENV_FACTORY } from "./env.js";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_8 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_9 || "https://bsc-dataseed2.binance.org/"
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs available");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 2 });

/* ================= CONSTANTS ================= */
const KNOWN_LOCKERS = [
  "0x5d47babaefbc3f2a1b20a36e7e6cb16e0ed7a6a8",
  "0x9e7bd1a3ac2b1a7e94f5c927fbce6a0e631eec21",
  "0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe",
  "0xe2fe530c047f2d85298b07d9333c05737f1435fb"
].map((a) => a.toLowerCase());

const BURN = "0x000000000000000000000000000000000000dead";

const PASS_SCORE = 65;
const TOTAL_SCORE = 80;

/* ================= ABIs ================= */
export const LP_ABI = [
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function factory() view returns(address)"
];

export const ERC20_ABI = [
  "function decimals() view returns(uint8)",
  "function totalSupply() view returns(uint256)"
];

const FACTORY_ABI = [
  "function getPair(address tokenA,address tokenB) view returns(address)"
];

/* ================= MINT SELECTORS ================= */
const MINT_SELECTORS = [
  "40c10f19", // mint(address,uint256)
  "6a627842", // mint(uint256)
  "8a7d4b73", // mint(address)
  "a0712d68"  // _mint(address,uint256)
];

/* ================= HELPERS ================= */
function norm(a) {
  try {
    return ethers.getAddress(String(a || "")).toLowerCase();
  } catch {
    return null;
  }
}

// Normalize imported constants too
const WBNB = norm(ENV_WBNB || process.env.WBNB_ADDRESS || "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
const PANCAKE_FACTORY = norm(ENV_FACTORY || process.env.PANCAKE_FACTORY);

if (!WBNB) throw new Error("WBNB address missing/invalid");
if (!PANCAKE_FACTORY) throw new Error("PANCAKE_FACTORY missing/invalid");

async function safeCall(fn) {
  let err;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (e) {
      err = e;
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
      console.warn("Switch RPC:", RPC_URLS[rpcIndex]);
    }
  }
  throw err;
}

async function getCode(addr) {
  return safeCall((p) => p.getCode(addr));
}

/* ================= ADDRESS CLASSIFICATION (BEP20 + PAIR ONLY) ================= */
async function classifyAddress(address) {
  const a = norm(address);
  if (!a) return { type: "INVALID" };

  const code = (await getCode(a))?.toLowerCase();
  if (!code || code === "0x") return { type: "EOA", address: a };

  // Try PAIR first
  try {
    const pair = new ethers.Contract(a, LP_ABI, provider);
    const [t0, t1, res, fac] = await safeCall(async (p) => {
      const c = pair.connect(p);
      return Promise.all([
        c.token0(),
        c.token1(),
        c.getReserves(),
        c.factory().catch(() => null)
      ]);
    });

    const t0n = norm(t0);
    const t1n = norm(t1);
    const facn = norm(fac);

    if (t0n && t1n && res && facn) {
      return { type: "PAIR", address: a, token0: t0n, token1: t1n };
    }
  } catch {
    // ignore
  }

  // Try BEP20 heuristic (decimals + totalSupply)
  try {
    const t = new ethers.Contract(a, ERC20_ABI, provider);
    const [dec, ts] = await safeCall(async (p) => {
      const c = t.connect(p);
      return Promise.all([c.decimals(), c.totalSupply()]);
    });
    if (dec !== null && ts !== null) return { type: "BEP20", address: a };
  } catch {
    // ignore
  }

  return { type: "PROGRAM", address: a };
}

/* ================= PAIR -> TOKEN RESOLUTION ================= */
async function resolveTokenFromPair(pairAddress) {
  const p = norm(pairAddress);
  if (!p) return null;

  return safeCall(async (prov) => {
    const pair = new ethers.Contract(
      p,
      ["function token0() view returns(address)", "function token1() view returns(address)"],
      prov
    );

    const t0 = norm(await pair.token0());
    const t1 = norm(await pair.token1());
    if (!t0 || !t1) return null;

    if (t0 === WBNB) return t1;
    if (t1 === WBNB) return t0;
    return null;
  });
}

/* ================= TOKEN -> WBNB PAIR ================= */
async function getWbnbPairForToken(tokenAddress) {
  const t = norm(tokenAddress);
  if (!t) return null;

  const factory = new ethers.Contract(PANCAKE_FACTORY, FACTORY_ABI, provider);

  try {
    const pair = await safeCall((p) => factory.connect(p).getPair(WBNB, t));
    const pp = norm(pair);
    const zero = norm(ethers.ZeroAddress);
    if (pp && pp !== zero) return pp;
  } catch {
    // ignore
  }

  return null;
}

/* ================= LP OWNER CHECK (PAIR ONLY) ================= */
async function lpOwnershipScore(pairAddress) {
  const p = norm(pairAddress);
  if (!p) return { ok: false, reason: ["INVALID_PAIR"] };

  try {
    const lp = new ethers.Contract(p, LP_ABI, provider);

    const [rawTotal, rawBurn] = await safeCall(async (prov) => {
      const c = lp.connect(prov);
      return Promise.all([
        c.totalSupply().catch(() => 0n),
        c.balanceOf(BURN).catch(() => 0n)
      ]);
    });

    const total = BigInt(rawTotal);
    const burned = BigInt(rawBurn);

    if (total === 0n) {
      return { ok: false, reason: ["LP_TOTAL_SUPPLY_ZERO_UNSAFE"], raw: { total: total.toString() } };
    }

    let locked = 0n;
    for (const locker of KNOWN_LOCKERS) {
      try {
        const bal = await safeCall((prov) => lp.connect(prov).balanceOf(locker));
        locked += BigInt(bal);
      } catch {
        // ignore
      }
    }
    if (locked > total) locked = total;

    const burnPct = Number((burned * 10000n) / total) / 100;
    const lockPct = Number((locked * 10000n) / total) / 100;

    const burnOk = burnPct >= 95;
    const lockOk = lockPct >= 95;

    const ok = burnOk || lockOk;
    if (!ok) {
      return {
        ok: false,
        reason: ["LP_UNLOCKED_UNSAFE"],
        raw: { total: total.toString(), burned: burned.toString(), locked: locked.toString(), burnPct, lockPct }
      };
    }

    return {
      ok: true,
      reason: [],
      raw: {
        total: total.toString(),
        burned: burned.toString(),
        locked: locked.toString(),
        burnPct,
        lockPct,
        status: burnOk && lockOk ? "BURNED_AND_LOCKED" : (burnOk ? "BURNED" : "LOCKED")
      }
    };
  } catch (e) {
    return { ok: false, reason: ["LP_CHECK_FAILED"], error: e?.message || String(e) };
  }
}

/* ================= SELL RESTRICTION SCAN (STATIC BYTECODE SIGNALS) ================= */
async function sellRestrictionScan(tokenAddress) {
  const t = norm(tokenAddress);
  if (!t) return { ok: false, flags: ["INVALID_TOKEN"], reason: "INVALID_TOKEN" };

  const code = (await getCode(t))?.toLowerCase();
  if (!code || code === "0x") return { ok: false, flags: ["NO_CODE"], reason: "NO_CODE" };

  const flags = [];

  const hexHints = {
    blacklist: "626c61636b6c697374",
    whitelist: "77686974656c697374",
    cooldown: "636f6f6c646f776e",
    maxTx: "6d61787478",
    maxWallet: "6d617877616c6c6574",
    sellLimit: "73656c6c6c696d6974",
    maxSell: "6d617873656c6c",
    tradingEnabled: "74726164696e67656e61626c6564"
  };

  if (code.includes(hexHints.blacklist)) flags.push("BLACKLIST_HINT");
  if (code.includes(hexHints.whitelist)) flags.push("WHITELIST_HINT");
  if (code.includes(hexHints.cooldown)) flags.push("COOLDOWN_HINT");
  if (code.includes(hexHints.maxTx)) flags.push("MAXTX_HINT");
  if (code.includes(hexHints.maxWallet)) flags.push("MAXWALLET_HINT");
  if (code.includes(hexHints.sellLimit) || code.includes(hexHints.maxSell)) flags.push("SELL_LIMIT_HINT");
  if (code.includes(hexHints.tradingEnabled)) flags.push("TRADING_TOGGLE_HINT");

  if (code.includes("f4")) flags.push("DELEGATECALL_OPCODE_PRESENT");

  const strong = new Set(["BLACKLIST_HINT", "WHITELIST_HINT", "SELL_LIMIT_HINT", "TRADING_TOGGLE_HINT"]);
  const hasStrong = flags.some((f) => strong.has(f));

  return { ok: !hasStrong, flags, reason: hasStrong ? "SELL_RESTRICTION_HINTS" : "OK" };
}

/* ================= MINT SCORE ================= */
export async function mintScore(tokenAddress, providerInstance) {
  const t = norm(tokenAddress);
  if (!t) return { ok: false, reason: ["INVALID_TOKEN"] };

  let ok = true;
  const reason = [];

  try {
    const code = (await providerInstance.getCode(t)).toLowerCase();
    if (code.includes("40c10f19")) {
      ok = false;
      reason.push("MINT_SELECTOR_DETECTED");
    }
  } catch {
    ok = false;
    reason.push("CONTRACT_UNREADABLE");
  }

  return { ok, reason };
}

/* ================= HIDDEN MINT + DELEGATECALL ================= */
async function hiddenMintDelegatecall(tokenAddress, providerInstance) {
  const t = norm(tokenAddress); // FIX: use norm, not normalize
  if (!t) return { ok: false, risky: true, reason: "INVALID_TOKEN" };

  const code = (await providerInstance.getCode(t)).toLowerCase();
  if (!code || code === "0x") return { ok: false, risky: true, reason: "NO_CODE" };

  const hasDelegatecall = code.includes("f4");
  const foundMint = MINT_SELECTORS.some((sig) => code.includes(sig));

  if (hasDelegatecall && foundMint) {
    return { ok: false, risky: true, reason: "DELEGATECALL_PLUS_MINT_SELECTOR" };
  }

  if (hasDelegatecall) {
    return {
      ok: true,
      risky: false,
      reason: "DELEGATECALL_PRESENT_BUT_NO_MINT_HINTS",
      note: "soft_signal"
    };
  }

  if (foundMint) {
    return { ok: false, risky: true, reason: "MINT_SELECTOR_PRESENT" };
  }

  return { ok: true, risky: false, reason: "NO_MINT_HINTS" };
}

/* ================= UNIFIED SCAN (PAIR/BEP20 ONLY) ================= */
export async function scanAddress(address) {
  const cls = await classifyAddress(address);

  if (cls.type === "PAIR") {
    const pairAddress = cls.address;
    const tokenAddress = await resolveTokenFromPair(pairAddress);
    if (!tokenAddress) return { ok: false, type: "PAIR", pairAddress, reason: "NOT_WBNB_PAIR" };

    const [lp, sellScan, mint, hiddenMint] = await Promise.all([
      lpOwnershipScore(pairAddress),
      sellRestrictionScan(tokenAddress),
      mintScore(tokenAddress, provider),
      hiddenMintDelegatecall(tokenAddress, provider)
    ]);

    return { ok: true, type: "PAIR", pairAddress, tokenAddress, checks: { lp, sellScan, mint, hiddenMint } };
  }

  if (cls.type === "BEP20") {
    const tokenAddress = cls.address;
    const pairAddress = await getWbnbPairForToken(tokenAddress);
    if (!pairAddress) return { ok: false, type: "BEP20", tokenAddress, reason: "NO_WBNB_PAIR_FOUND" };

    const [sellScan, mint, hiddenMint] = await Promise.all([
      sellRestrictionScan(tokenAddress),
      mintScore(tokenAddress, provider),
      hiddenMintDelegatecall(tokenAddress, provider)
    ]);

    const lp = { ok: true, reason: ["SKIPPED_FOR_TOKEN_INPUT"] };
    return { ok: true, type: "BEP20", tokenAddress, pairAddress, checks: { lp, sellScan, mint, hiddenMint } };
  }

  if (cls.type === "PROGRAM") {
    return { ok: false, type: "PROGRAM", address: cls.address, reason: "PROGRAM_CONTRACT_REJECTED" };
  }

  return { ok: false, type: cls.type, reason: "UNSUPPORTED_OR_INVALID" };
}

/* ================= SCORE WRAPPER (TOTAL 80, PASS 70) ================= */
export async function walletRate(address) {
  const scan = await scanAddress(address);

  if (!scan?.ok) {
    return {
      input: address,
      ok: false,
      pass: false,
      type: scan?.type || null,
      reason: scan?.reason || "FAILED",
      details: scan || null,
      totalScore: 0,
      totalPossible: TOTAL_SCORE,
      passScore: PASS_SCORE,
      scores: null,
      checks: scan?.checks || null
    };
  }

  const checks = scan.checks || {};

  const lpOk = scan.type === "PAIR" ? (checks.lp?.ok ? 20 : 0) : 20;
  const sellOk = checks.sellScan?.ok ? 20 : 0;
  const mintOk = checks.mint?.ok ? 20 : 0;

  let hiddenOk = 0;
  if (checks.hiddenMint?.ok) {
    hiddenOk = checks.hiddenMint?.note === "soft_signal" ? 10 : 20;
  }

  const totalScore = lpOk + sellOk + mintOk + hiddenOk;
  const pass = totalScore >= PASS_SCORE;

  return {
    input: address,
    ok: true,
    pass,
    reason: pass ? "PASS" : "SCORE_BELOW_THRESHOLD",
    type: scan.type,
    tokenAddress: scan.tokenAddress || scan.tokenAddress === "" ? scan.tokenAddress : (scan.tokenAddress ?? null),
    pairAddress: scan.pairAddress || null,

    // FIX: map correct fields from scanAddress output
    tokenAddress: scan.tokenAddress ?? scan.tokenAddress,
    pairAddress: scan.pairAddress ?? scan.pairAddress,

    totalScore,
    totalPossible: TOTAL_SCORE,
    passScore: PASS_SCORE,

    scores: {
      lp: lpOk,
      sellRestrictionScan: sellOk,
      mint: mintOk,
      hiddenMintDelegatecall: hiddenOk
    },

    checks
  };
}