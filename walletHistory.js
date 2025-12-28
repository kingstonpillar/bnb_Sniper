import dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";
import PQueue from "p-queue";

/* ================= RPC CONFIG (LOCAL ONLY) ================= */
const RPC_URLS = [
  process.env.RPC_URL_8,
  process.env.RPC_URL_9
].filter(Boolean);

if (RPC_URLS.length < 1) {
  throw new Error("walletHistory: No RPC_URLS configured");
}

const rpcQueue = new PQueue({
  interval: 1000,
  intervalCap: 5,
  concurrency: 3
});

let rpcIndex = 0;
let provider = new Web3(RPC_URLS[rpcIndex]);

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new Web3(RPC_URLS[rpcIndex]);
}

async function safeRpcCall(fn) {
  let lastErr;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (e) {
      lastErr = e;
      rotateRpc();
    }
  }
  throw lastErr;
}

/* ================= ENV ADDRESSES ================= */
function mustAddress(name, value) {
  if (!value || typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`${name} missing or invalid in .env`);
  }
  return value.toLowerCase();
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const WBNB    = mustAddress("WBNB_ADDRESS", process.env.WBNB_ADDRESS);
const ROUTER  = mustAddress("PANCAKE_ROUTER", process.env.PANCAKE_ROUTER);
const FACTORY = mustAddress("PANCAKE_FACTORY", process.env.PANCAKE_FACTORY);

/* ================= ABIs ================= */
const FACTORY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" }
    ],
    name: "getPair",
    outputs: [{ internalType: "address", name: "pair", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
];

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function"
  }
];

const PAIR_ABI = [
  /* ================= CORE SWAP ================= */
  {
    name: "swap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount0Out", type: "uint256" },
      { name: "amount1Out", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" }
    ],
    outputs: []
  },

  /* ================= LIQUIDITY OPS ================= */
  {
    name: "skim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" }
    ],
    outputs: []
  },
  {
    name: "sync",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  },

  /* ================= RESERVES ================= */
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" }
    ]
  },

  /* ================= TOKEN ORDER ================= */
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  }
];
const ERC20_MIN_ABI = [
  { name: "transfer", type: "function", inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
  ]},
  { name: "transferFrom", type: "function", inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
  ]},
  { name: "allowance", type: "function", inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
  ]}
];

/* ================= RUG MEMORY ================= */
const devMemory = {}; // { dev: { deploys: number, rugs: number } }

/* ================= DEV WALLET ================= */
export async function getDevWallet(token) {
  return safeRpcCall(async (web3) => {
    const latest = Number(await web3.eth.getBlockNumber());
const LOOKBACK = 28800 * 3;
const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0;
    const TRANSFER_TOPIC =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO_TOPIC =
      "0x0000000000000000000000000000000000000000000000000000000000000000";

    let logs = [];
    try {
      logs = await web3.eth.getPastLogs({
        fromBlock: fromBlock.toString(),
        toBlock: "latest",
        address: token,
        topics: [TRANSFER_TOPIC]
      });
    } catch {}

    if (!logs.length) return null;

    // Prefer mint
    const mintLog = logs.find(l => l.topics[1] === ZERO_TOPIC);
    if (mintLog) {
      const dev = "0x" + mintLog.topics[2].slice(26);
      return dev.toLowerCase();
    }

    // Fallback earliest transfer
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const first = logs[0];
    return "0x" + first.topics[1].slice(26);
  });
}

/**
 * detectSellRestrictionStrict
 * --------------------------
 * Checks a token for hard sell restrictions using both:
 *   1️⃣ Bytecode analysis (time/block-based sell blocks)
 *   2️⃣ Storage slot inspection (owner-controlled or blacklist flags)
 *
 * Returns `true` if any restriction is detected—trading is unsafe.
 */
 async function detectSellRestrictionStrict(token, web3) {
  const bytecode = await web3.eth.getCode(token);
  if (!bytecode || bytecode === "0x") return false;

  const code = bytecode.replace(/^0x/, '');
  for (let i = 0; i < code.length - 2; i += 2) {
    const op = parseInt(code.slice(i, i + 2), 16);
    if (op === 0x42 || op === 0x43) { // TIMESTAMP / BLOCKNUMBER
      const lookaheadHex = code.slice(i + 2, i + 42).match(/.{2}/g) || [];
      const lookahead = lookaheadHex.map(b => parseInt(b, 16));
      const suspicious = lookahead.some(o => o === 0x57 || o === 0xfd); // JUMPI / REVERT
      const trivial = lookahead.includes(0x00) || lookahead.includes(0x01);
      if (suspicious && !trivial) {
        return true; // restriction detected in bytecode → error
      }
    }
  }

  // 2️⃣ Check known storage slots for active restrictions
  const storageSlots = [
    "0x0", // usually owner / sell flag mapping
    "0x1", // possible blacklist
    // add other suspicious slots if known
  ];

  for (const slot of storageSlots) {
    const value = await web3.eth.getStorageAt(token, slot);
    if (value && value !== "0x0") {
      return true; // active restriction detected → error
    }
  }

  return false; // no restriction detected
}


  
/* ================= LP OWNER CONTROL ================= */
export async function checkLpOwner(token) {
  return safeRpcCall(async (web3) => {
    const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);

    const pair = await factory.methods.getPair(token, WBNB).call();
    if (!pair || pair === ZERO_ADDR) return { lpExists: false, reason: "NO_PAIR" };

    const lpContract = new web3.eth.Contract(ERC20_ABI, pair);

    const dev = await getDevWallet(token);
    if (!dev) return { lpExists: true, controlled: false, reason: "NO_DEV_INFO" };

    const balance = await lpContract.methods.balanceOf(dev).call();
    let controlled = BigInt(balance) > 0n;

    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

    const logs = await web3.eth.getPastLogs({ address: pair, fromBlock: 0, toBlock: "latest", topics: [TRANSFER] });
    const mintLog = logs.find(l => l.topics[1] === ZERO);
    if (!mintLog) return { lpExists: true, controlled, reason: "NO_MINT_EVENT" };

    const mintedTo = "0x" + mintLog.topics[2].slice(26).toLowerCase();
    let movedAfterMint = false;
    let currentOwner = mintedTo;

    for (const log of logs) {
      if (log.blockNumber < mintLog.blockNumber) continue;
      const from = "0x" + log.topics[1].slice(26).toLowerCase();
      const to = "0x" + log.topics[2].slice(26).toLowerCase();
      if (from === currentOwner && to !== currentOwner) {
        movedAfterMint = true;
        currentOwner = to;
      }
    }

    if (movedAfterMint || currentOwner !== dev) controlled = false;

    return {
      lpExists: true,
      controlled,
      mintedTo,
      movedAfterMint,
      currentOwner,
      reason: controlled ? "DEV_STILL_CONTROLS_LP" : "LP_SAFE"
    };
  });
}

/* =========================================================
   🔹 SAFE LP BEHAVIOR SIMULATION 🔹
   Uses RPC queue & rotation to safely check LP functions
   - swap
   - skim
   - sync
   - reserves
   ---------------------------------------------------------
   Returns { ok, flags, reason } for trap detection
   ========================================================= */
   export async function simulateLpBehavior(token) {
  return safeRpcCall(async (web3) => {
    const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    const pair = await factory.methods.getPair(token, WBNB).call();

    if (!pair || pair === ZERO_ADDR) {
      return { ok: false, reason: "NO_PAIR" };
    }

    const pairContract = new web3.eth.Contract(PAIR_ABI, pair);
    const dummy = "0x000000000000000000000000000000000000dead";

    let flags = {
      swapBlocked: false,
      skimBlocked: false,
      syncBlocked: false,
      noReserves: false
    };

    /* getReserves */
    try {
      const reserves = await pairContract.methods.getReserves().call();
      const reserve0 = reserves.reserve0 ?? reserves[0];
      const reserve1 = reserves.reserve1 ?? reserves[1];

      if (BigInt(reserve0) === 0n || BigInt(reserve1) === 0n) {
        flags.noReserves = true;
      }
    } catch {
      flags.noReserves = true;
    }

    /* swap (small test) */
    try {
      await pairContract.methods.swap(1, 1, dummy, "0x").call({ from: dummy });
    } catch {
      flags.swapBlocked = true;
    }

    /* skim */
    try {
      if (!flags.noReserves) await pairContract.methods.skim(dummy).call({ from: dummy });
    } catch {
      flags.skimBlocked = true;
    }

    /* sync */
    try {
      if (!flags.noReserves) await pairContract.methods.sync().call({ from: dummy });
    } catch {
      flags.syncBlocked = true;
    }

    const blocked = flags.swapBlocked || flags.noReserves || flags.skimBlocked || flags.syncBlocked;

    // Detailed blocked operations
    const blockedOps = Object.entries(flags)
      .filter(([_, v]) => v)
      .map(([k]) => k)
      .join(", ");

    return {
      ok: !blocked,
      flags,
      reason: blocked ? `LP_TRAP: ${blockedOps}` : "LP_OK"
    };
  });
}

/* =========================================================
   🔥 SWAP FEE CHECK — HIGH TAX / SOFT HONEYPOT DETECTION
   ---------------------------------------------------------
   Purpose:
   - Detect tokens with excessive buy/sell taxes
   - Catch “sellable but unusable” tokens (99% tax traps)
   - Works WITHOUT buying the token
   ---------------------------------------------------------
   Scoring Guidance:
   - <= 10% fee  → OK
   - 11–20% fee  → risky
   - > 20% fee   → FAIL (revert / unhealthy)
   ========================================================= */

export async function swapFeeCheck(token) {
  return safeRpcCall(async (web3) => {
    /* -------- Router ABI (minimal) -------- */
    const routerAbi = [
      {
        name: "getAmountsOut",
        type: "function",
        inputs: [
          { name: "amountIn", type: "uint256" },
          { name: "path", type: "address[]" }
        ],
        outputs: [{ name: "amounts", type: "uint256[]" }],
        stateMutability: "view"
      }
    ];

    /* -------- Get Pair -------- */
    const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    const pair = await factory.methods.getPair(token, WBNB).call();
    if (!pair || pair === ZERO_ADDR) return { ok: false, reason: "NO_PAIR" };

    const pairContract = new web3.eth.Contract(PAIR_ABI, pair);
    const router = new web3.eth.Contract(routerAbi, ROUTER);

    /* -------- Load reserves -------- */
    let reserves;
    try { reserves = await pairContract.methods.getReserves().call(); }
    catch { return { ok: false, reason: "NO_RESERVES" }; }

    const token0 = await pairContract.methods.token0().call();
    const token1 = await pairContract.methods.token1().call();

    let tokenReserve, wbnbReserve;
    if (token0.toLowerCase() === token.toLowerCase()) {
      tokenReserve = BigInt(reserves.reserve0);
      wbnbReserve  = BigInt(reserves.reserve1);
    } else if (token1.toLowerCase() === token.toLowerCase()) {
      tokenReserve = BigInt(reserves.reserve1);
      wbnbReserve  = BigInt(reserves.reserve0);
    } else {
      return { ok: false, reason: "PAIR_MISMATCH" };
    }

    if (tokenReserve === 0n || wbnbReserve === 0n) return { ok: false, reason: "EMPTY_LP" };

    /* -------- AMM Expected Output -------- */
    const amountIn = tokenReserve / 1000n;
    const k = tokenReserve * wbnbReserve;
    const expectedOut = wbnbReserve - (k / (tokenReserve + amountIn));

    /* -------- Router Quote -------- */
    let quoted;
    try {
      quoted = await router.methods.getAmountsOut(amountIn.toString(), [token, WBNB]).call();
    } catch { return { ok: false, reason: "ROUTER_REVERT" }; }

    const actualOut = BigInt(quoted[1]);
    if (actualOut === 0n) return { ok: false, fee: 100, reason: "100_PERCENT_TAX" };

    /* -------- Fee Calculation -------- */
    const feePercent = Number(((expectedOut - actualOut) * 100n) / expectedOut);
    if (feePercent > 10) return { ok: false, fee: feePercent, reason: "HIGH_SWAP_FEE" };

    return { ok: true, fee: feePercent, reason: "FEE_OK" };
  });
}
/* ================= WALLET RATE ================= */

export async function walletRate(token) {
  const result = {
    token,
    totalScore: 0,
    health: "unhealthy",
    details: {
      sellSimulation: { score: 0, status: "unhealthy" },
      lpTrap: { score: 0, status: "unhealthy" },
      lpOwnership: { score: 0, status: "unhealthy" },
      swapFee: { score: 0, status: "unhealthy" },
      devWallet: { score: 0, status: "unhealthy" }
    }
  };

  /* 1️⃣ HARD SELL RESTRICTION — 20 */
  const isRestricted = await safeRpcCall(async (web3) => {
  return detectSellRestrictionStrict(token, web3);
});

  if (isRestricted) {
    result.details.sellSimulation = {
      score: 0,
      status: "unhealthy",
      reason: "HARD_SELL_RESTRICTION"
    };
    return result; // hard stop
  }

  result.details.sellSimulation = { score: 20, status: "healthy" };
  result.totalScore += 20;

  /* 2️⃣ LP TRAP — 15 (NO PARTIAL) */
  const lpSim = await simulateLpBehavior(token);
  if (!lpSim.ok) {
    result.details.lpTrap = {
      score: 0,
      status: "unhealthy",
      reason: lpSim.reason,
      flags: lpSim.flags
    };
  } else {
    result.details.lpTrap = { score: 15, status: "healthy" };
    result.totalScore += 15;
  }

  /* 3️⃣ LP OWNERSHIP — 15 (NO LP = 0) */
  const lp = await checkLpOwner(token);
  if (!lp.lpExists) {
  result.details.lpOwnership.reason = "NO_LP";
} else if (lp.controlled) {
  result.details.lpOwnership.reason = "LP_CONTROLLED";
} else {
  result.details.lpOwnership = { score: 15, status: "healthy" };
  result.totalScore += 15;
}

  /* 4️⃣ SWAP FEE — 15 (STRICT) */
  const fee = await swapFeeCheck(token);
  if (fee.ok && fee.fee <= 10) {
    result.details.swapFee = {
      score: 15,
      status: "healthy",
      fee: fee.fee
    };
    result.totalScore += 15;
  }

  /* 5️⃣ DEV WALLET — 10 (ZERO RUG HISTORY ONLY) */
  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) {
    result.details.devWallet = { score: 10, status: "healthy" };
    result.totalScore += 10;
  }

  /* FINAL HEALTH */
  result.health = result.totalScore >= 60 ? "healthy" : "unhealthy";
  return result;
}