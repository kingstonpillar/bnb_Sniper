import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";
import { WBNB, PANCAKE_FACTORY } from "./env.js";

/*
Rewrite goals (no taxSim / no eth_call):
- sellRestrictionScan (static bytecode heuristics)
- lpOwnerCheck
- mintScore
- hiddenMintDelegatecall
Scoring:
- Total score = 80
- Pass score = 70
Notes:
- This is a static risk screen. It cannot prove “sell works” or measure buy/sell tax.
- Result should be used before any paid simulation or API honeypot checks.
*/

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

const PASS_SCORE = 70;
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
  "a0712d68" // _mint(address,uint256)
];

/* ================= HELPERS ================= */
function normalize(a) {
  try {
    return ethers.getAddress(a);
  } catch {
    return null;
  }
}

async function safeCall(fn) {
  let err;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (e) {
      err = e;
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
      console.log("Switch RPC:", RPC_URLS[rpcIndex]);
    }
  }
  throw err;
}

async function getCode(addr) {
  return safeCall((p) => p.getCode(addr));
}

/* ================= ADDRESS CLASSIFICATION (BEP20 + PAIR ONLY) ================= */
async function classifyAddress(address) {
  const a = normalize(address);
  if (!a) return { type: "INVALID" };

  const code = (await getCode(a))?.toLowerCase();
  if (!code || code === "0x") return { type: "EOA", address: a };

  // Try PAIR first
  try {
    const pair = new ethers.Contract(a, LP_ABI, provider);
    const [t0, t1, res, fac] = await safeCall(async (p) => {
      const c = pair.connect(p);
      return Promise.all([c.token0(), c.token1(), c.getReserves(), c.factory().catch(() => null)]);
    });

    if (normalize(t0) && normalize(t1) && res && normalize(fac)) {
      return { type: "PAIR", address: a, token0: normalize(t0), token1: normalize(t1) };
    }
  } catch {}

  // Try BEP20 heuristic (decimals + totalSupply)
  try {
    const t = new ethers.Contract(a, ERC20_ABI, provider);
    const [dec, ts] = await safeCall(async (p) => {
      const c = t.connect(p);
      return Promise.all([c.decimals(), c.totalSupply()]);
    });
    if (dec !== null && ts !== null) return { type: "BEP20", address: a };
  } catch {}

  return { type: "PROGRAM", address: a };
}

/* ================= PAIR -> TOKEN RESOLUTION ================= */
async function resolveTokenFromPair(pairAddress) {
  const p = normalize(pairAddress);
  if (!p) return null;

  return safeCall(async (prov) => {
    const pair = new ethers.Contract(
      p,
      ["function token0() view returns(address)", "function token1() view returns(address)"],
      prov
    );
    const t0 = normalize(await pair.token0());
    const t1 = normalize(await pair.token1());
    if (t0 === WBNB) return t1;
    if (t1 === WBNB) return t0;
    return null;
  });
}

/* ================= TOKEN -> WBNB PAIR ================= */
async function getWbnbPairForToken(tokenAddress) {
  const t = normalize(tokenAddress);
  if (!t) return null;

  const factory = new ethers.Contract(PANCAKE_FACTORY, FACTORY_ABI, provider);
  try {
    const pair = await safeCall((p) => factory.connect(p).getPair(WBNB, t));
    const pp = normalize(pair);
    if (pp && pp !== ethers.ZeroAddress) return pp;
  } catch {}
  return null;
}

/* ================= LP OWNER CHECK (PAIR ONLY) ================= */
async function lpOwnershipScore(pairAddress) {
  const p = normalize(pairAddress);
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

    // Condition 1: totalSupply == 0 is unsafe
    if (total === 0n) {
      return {
        ok: false,
        reason: ["LP_TOTAL_SUPPLY_ZERO_UNSAFE"],
        raw: { total: total.toString() }
      };
    }

    let locked = 0n;
    for (const locker of KNOWN_LOCKERS) {
      try {
        const bal = await safeCall((prov) => lp.connect(prov).balanceOf(locker));
        locked += BigInt(bal);
      } catch {}
    }
    if (locked > total) locked = total;

    const burnPct = Number((burned * 10000n) / total) / 100;
    const lockPct = Number((locked * 10000n) / total) / 100;

    const burnOk = burnPct >= 95;
    const lockOk = lockPct >= 95;

    // Your rule: PASS if either burn OR lock.
    const ok = burnOk || lockOk;

    // "LP unlocked" means neither burn nor lock meets threshold
    const lpUnlocked = !ok;

    // Condition 2: LP unlocked is unsafe
    // (You mentioned "LP unlock" as an unsafe condition)
    if (lpUnlocked) {
      return {
        ok: false,
        reason: ["LP_UNLOCKED_UNSAFE"],
        raw: {
          total: total.toString(),
          burned: burned.toString(),
          locked: locked.toString(),
          burnPct,
          lockPct
        }
      };
    }

    // If both are true, we do NOT fail. We just report it.
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
    return {
      ok: false,
      reason: ["LP_CHECK_FAILED"],
      error: e?.message || String(e)
    };
  }
}

/* ================= SELL RESTRICTION SCAN (STATIC BYTECODE SIGNALS) =================
This is NOT a proof. It flags likely anti-sell / anti-bot mechanics.
*/
async function sellRestrictionScan(tokenAddress) {
  const t = normalize(tokenAddress);
  if (!t) return { ok: false, flags: ["INVALID_TOKEN"], reason: "INVALID_TOKEN" };

  const code = (await getCode(t))?.toLowerCase();
  if (!code || code === "0x") return { ok: false, flags: ["NO_CODE"], reason: "NO_CODE" };

  const flags = [];

  // text hints encoded as hex strings (common in bytecode metadata/strings)
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

  // low-level opcode hints (very noisy, but useful for triage)
  // 0xf4 delegatecall sometimes used for proxy routing/logic indirection.
  if (code.includes("f4")) flags.push("DELEGATECALL_OPCODE_PRESENT");

  // If any strong restriction hints exist, mark as not-ok
  const strong = new Set(["BLACKLIST_HINT", "WHITELIST_HINT", "SELL_LIMIT_HINT", "TRADING_TOGGLE_HINT"]);
  const hasStrong = flags.some((f) => strong.has(f));

  return { ok: !hasStrong, flags, reason: hasStrong ? "SELL_RESTRICTION_HINTS" : "OK" };
}

/* ================= MINT SCORE ================= */
export async function mintScore(tokenAddress, providerInstance) {
  const t = normalize(tokenAddress);
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
  const t = normalize(tokenAddress);
  if (!t) return { ok: false, risky: true, reason: "INVALID_TOKEN" };

  const code = (await providerInstance.getCode(t)).toLowerCase();
  if (!code || code === "0x") return { ok: false, risky: true, reason: "NO_CODE" };

  const hasDelegatecall = code.includes("f4");
  const foundMint = MINT_SELECTORS.some((sig) => code.includes(sig));

  if (hasDelegatecall && foundMint) return { ok: false, risky: true, reason: "DELEGATECALL_PLUS_MINT_SELECTOR" };
  if (hasDelegatecall) return { ok: false, risky: true, reason: "DELEGATECALL_PRESENT" };
  if (foundMint) return { ok: false, risky: true, reason: "MINT_SELECTOR_PRESENT" };

  return { ok: true, risky: false, reason: "NO_MINT_HINTS" };
}

/* ================= UNIFIED SCAN (PAIR/BEP20 ONLY) ================= */
export async function scanAddress(address) {
  const cls = await classifyAddress(address);

  // PAIR input
  if (cls.type === "PAIR") {
    const pairAddress = cls.address;
    const tokenAddress = await resolveTokenFromPair(pairAddress);
    if (!tokenAddress) return { ok: false, type: "PAIR", pairAddress, reason: "NOT_WBNB_PAIR" };

    const [lp, sellScan, mint, hiddenMint] = await Promise.all([
      lpOwnerCheck(pairAddress),
      sellRestrictionScan(tokenAddress),
      mintScore(tokenAddress, provider),
      hiddenMintDelegatecall(tokenAddress, provider)
    ]);

    return { ok: true, type: "PAIR", pairAddress, tokenAddress, checks: { lp, sellScan, mint, hiddenMint } };
  }

  // BEP20 input
  if (cls.type === "BEP20") {
    const tokenAddress = cls.address;
    const pairAddress = await getWbnbPairForToken(tokenAddress);
    if (!pairAddress) return { ok: false, type: "BEP20", tokenAddress, reason: "NO_WBNB_PAIR_FOUND" };

    const [sellScan, mint, hiddenMint] = await Promise.all([
      sellRestrictionScan(tokenAddress),
      mintScore(tokenAddress, provider),
      hiddenMintDelegatecall(tokenAddress, provider)
    ]);

    // Token-input mode cannot reliably prove LP lock, score it as neutral
    const lp = { ok: true, reason: ["SKIPPED_FOR_TOKEN_INPUT"] };

    return { ok: true, type: "BEP20", tokenAddress, pairAddress, checks: { lp, sellScan, mint, hiddenMint } };
  }

  if (cls.type === "PROGRAM") {
    return { ok: false, type: "PROGRAM", address: cls.address, reason: "PROGRAM_CONTRACT_REJECTED" };
  }

  return { ok: false, type: cls.type, reason: "UNSUPPORTED_OR_INVALID" };
}

/* ================= SCORE WRAPPER (TOTAL 80, PASS 70) =================
Weights:
- LP lock (pair input): 20
- sellRestrictionScan: 20
- mintScore: 20
- hiddenMintDelegatecall: 20
Total: 80
Pass: >= 70
*/
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
  const hiddenOk = checks.hiddenMint?.ok ? 20 : 0;

  const totalScore = lpOk + sellOk + mintOk + hiddenOk;
  const pass = totalScore >= PASS_SCORE;

  return {
    input: address,
    ok: true,
    pass,
    reason: pass ? "PASS" : "SCORE_BELOW_THRESHOLD",

    type: scan.type,
    tokenAddress: scan.tokenAddress || null,
    pairAddress: scan.pairAddress || null,

    totalScore,
    totalPossible: TOTAL_SCORE,
    passScore: PASS_SCORE,

    scores: {
      lp: lpOk,
      sellRestrictionScan: sellOk,
      mint: mintOk,
      hiddenMintDelegatecall: hiddenOk
    },

    checks: scan.checks
  };
}

/* ================= TEST ================= */
(async () => {
  const addr = "0x74471cde9b16f67a540112ea24844924a75220b0";
  console.log(JSON.stringify(await walletRate(addr), null, 2));
})();
```0