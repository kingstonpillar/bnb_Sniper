import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import PQueue from "p-queue";

/* ================= RPC ================= */
const RPCS = [process.env.RPC_URL_8, process.env.RPC_URL_9].filter(Boolean);
if (!RPCS.length) throw new Error("No RPC URLs configured");

let rpcIndex = 0;
function getWeb3() {
  return new Web3(RPCS[rpcIndex]);
}
function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  return getWeb3();
}

const queue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 5 });

async function safeCall(fn) {
  let web3 = getWeb3();
  try {
    return await fn(web3);
  } catch (e1) {
    try {
      web3 = rotateRpc();
      return await fn(web3);
    } catch (e2) {
      throw e1; // return original error
    }
  }
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
  return queue.add(() =>
    safeCall(async (web3) => {
      const latest = await web3.eth.getBlockNumber();
      const LOOKBACK = 28800n * 3n;
      const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0n;
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
    })
  );
}

/* ================= SELL RESTRICTIONS================= */
export async function detectSellRestrictions(token) {
  return queue.add(() =>
    safeCall(async (web3) => {
      const tokenContract = new web3.eth.Contract(ERC20_MIN_ABI, token);

      const pair = await new web3.eth.Contract(
        FACTORY_ABI,
        FACTORY
      ).methods.getPair(token, WBNB).call();

      if (!pair || pair === ZERO_ADDR) {
        return { blocked: true, reason: "NO_PAIR" };
      }

      const router = ROUTER;
      const dummy = "0x000000000000000000000000000000000000dead";
      const dust = "1000000000000000"; // 1e15

      let flags = {
        transferBlocked: false,
        transferFromBlocked: false,
        pairBlocked: false,
        routerBlocked: false
      };

      /* 1️⃣ transfer() */
      try {
        await tokenContract.methods
          .transfer(pair, dust)
          .call({ from: dummy });
      } catch {
        flags.transferBlocked = true;
      }

      /* 2️⃣ transferFrom() */
      try {
        await tokenContract.methods
          .transferFrom(dummy, pair, dust)
          .call({ from: router });
      } catch {
        flags.transferFromBlocked = true;
      }

      /* 3️⃣ pair as sender */
      try {
        await tokenContract.methods
          .transfer(router, dust)
          .call({ from: pair });
      } catch {
        flags.pairBlocked = true;
      }

      /* 4️⃣ router as sender */
      try {
        await tokenContract.methods
          .transfer(pair, dust)
          .call({ from: router });
      } catch {
        flags.routerBlocked = true;
      }

      /* 5️⃣ Decision */
      const blocked =
  flags.transferFromBlocked ||
  flags.routerBlocked ||
  flags.pairBlocked ||
  (flags.transferBlocked && flags.routerBlocked);

      return {
        blocked,
        flags,
        reason: blocked ? "SELL_RESTRICTED" : "SELL_OK"
      };
    })
  );
}

/* ================= LP OWNER CONTROL ================= */
export async function checkLpOwner(token) {
  const web3 = getWeb3();
  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);

  // 1️⃣ Get LP pair
  const pair = await factory.methods.getPair(token, WBNB).call();
  if (!pair || pair === "0x0000000000000000000000000000000000000000") {
    return { lpExists: false, reason: "NO_PAIR" };
  }

  const lpContract = new web3.eth.Contract(ERC20_ABI, pair);

  // 2️⃣ Find dev wallet
  const dev = await getDevWallet(token);
  if (!dev) return { lpExists: true, controlled: false, reason: "NO_DEV_INFO" };

  // 3️⃣ Check if dev holds LP now
  const balance = await lpContract.methods.balanceOf(dev).call();
  let controlled = BigInt(balance) > 0n;

  // 4️⃣ Check LP transfer history after mint
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

  // 5️⃣ Determine control
  if (movedAfterMint || currentOwner !== dev) controlled = false;

  return {
    lpExists: true,
    controlled,
    mintedTo,
    movedAfterMint,
    currentOwner,
    reason: controlled ? "DEV_STILL_CONTROLS_LP" : "LP_SAFE"
  };
}

export async function simulateLpBehavior(token) {
  return queue.add(() =>
    safeCall(async (web3) => {
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
  const r = await pairContract.methods.getReserves().call();

  const reserve0 = r.reserve0 ?? r[0];
  const reserve1 = r.reserve1 ?? r[1];

  if (BigInt(reserve0) === 0n || BigInt(reserve1) === 0n) {
    flags.noReserves = true;
  }
} catch {
  flags.noReserves = true;
}
      /* swap (zero output) */
      try {
        await pairContract.methods
          .swap(0, 0, dummy, "0x")
          .call({ from: dummy });
      } catch {
        flags.swapBlocked = true;
      }

      /* skim */
      try {
        await pairContract.methods
          .skim(dummy)
          .call({ from: dummy });
      } catch {
        flags.skimBlocked = true;
      }

      /* sync */
      try {
        await pairContract.methods
          .sync()
          .call({ from: dummy });
      } catch {
        flags.syncBlocked = true;
      }

      const blocked =
        flags.swapBlocked &&
        (flags.skimBlocked || flags.syncBlocked);

      return {
        ok: !blocked,
        flags,
        reason: blocked ? "LP_TRAP" : "LP_OK"
      };
    })
  );
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
  return queue.add(() =>
    safeCall(async (web3) => {

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

      if (!pair || pair === ZERO_ADDR) {
        return { ok: false, reason: "NO_PAIR" };
      }

      const pairContract = new web3.eth.Contract(PAIR_ABI, pair);
      const router = new web3.eth.Contract(routerAbi, ROUTER);

      /* -------- Load reserves -------- */
      let reserves;
      try {
        reserves = await pairContract.methods.getReserves().call();
      } catch {
        return { ok: false, reason: "NO_RESERVES" };
      }

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

      if (tokenReserve === 0n || wbnbReserve === 0n) {
        return { ok: false, reason: "EMPTY_LP" };
      }

      /* -------- AMM Expected Output -------- */
      const amountIn = tokenReserve / 1000n; // 0.1% of LP
      const k = tokenReserve * wbnbReserve;

      const expectedOut =
        wbnbReserve - (k / (tokenReserve + amountIn));

      /* -------- Router Quote (tax-aware) -------- */
      let quoted;
      try {
        quoted = await router.methods
          .getAmountsOut(amountIn.toString(), [token, WBNB])
          .call();
      } catch {
        return { ok: false, reason: "ROUTER_REVERT" };
      }

      const actualOut = BigInt(quoted[1]);

      if (actualOut === 0n) {
        return { ok: false, fee: 100, reason: "100_PERCENT_TAX" };
      }

      /* -------- Fee Calculation -------- */
      const feePercent =
        Number(((expectedOut - actualOut) * 100n) / expectedOut);

      if (feePercent > 10) {
        return {
          ok: false,
          fee: feePercent,
          reason: "HIGH_SWAP_FEE"
        };
      }

      return {
        ok: true,
        fee: feePercent,
        reason: "FEE_OK"
      };
    })
  );
}
/* ================= WALLET RATE ================= */
export async function walletRate(token) {
  const result = {
    token,
    totalScore: 0,
    health: "unhealthy",
    details: {
      sellSimulation: { score: 0, status: "unhealthy" }, // 20
      lpTrap: { score: 0, status: "unhealthy" },         // 15
      lpOwnership: { score: 0, status: "unhealthy" },    // 15
      swapFee: { score: 0, status: "unhealthy" },        // 15
      devWallet: { score: 0, status: "unhealthy" }       // 10
    }
  };

  /* 1️⃣ SELL RESTRICTIONS — 20 POINTS */
  const sell = await detectSellRestrictions(token);
  if (!sell.blocked) {
    result.details.sellSimulation = { score: 20, status: "healthy" };
    result.totalScore += 20;
  }

  /* 2️⃣ LP TRAP SIMULATION — 15 POINTS */
  const lpSim = await simulateLpBehavior(token);
  if (lpSim.ok) {
    result.details.lpTrap = { score: 15, status: "healthy" };
    result.totalScore += 15;
  }

  /* 3️⃣ LP OWNER CONTROL — 15 POINTS */
  const lp = await checkLpOwner(token);
  if (lp.lpExists && !lp.controlled) {
    result.details.lpOwnership = { score: 15, status: "healthy" };
    result.totalScore += 15;
  }

  /* 4️⃣ SWAP FEE CHECK — 15 POINTS */
  const fee = await swapFeeCheck(token);
  if (fee.ok && fee.fee <= 10) {
    result.details.swapFee = { score: 15, status: "healthy", fee: fee.fee };
    result.totalScore += 15;
  }

  /* 5️⃣ DEV WALLET REPUTATION — 10 POINTS */
  const dev = await getDevWallet(token);
  if (dev) {
    const mem = devMemory[dev] || { rugs: 0 };
    if (mem.rugs === 0) {
      result.details.devWallet = { score: 10, status: "healthy" };
      result.totalScore += 10;
    }
  }

  /* ✅ FINAL HEALTH THRESHOLD */
  if (result.totalScore >= 60) {
    result.health = "healthy";
  } else {
    result.health = "unhealthy";
  }

  return result;
}