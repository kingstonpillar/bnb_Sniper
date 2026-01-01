/* ===========================================================
   🔹 BNB SNIPER SAFETY MODULE (BIGINT-SAFE)
   All calculations use BigInt to avoid type errors
   Checks: LP Ownership, Sell Simulation, Swap Fee, Dev Wallet
=========================================================== */

import dotenv from 'dotenv';
dotenv.config();

import { ethers } from "ethers";
import Web3 from "web3";
import PQueue from "p-queue";
import { LOCKER_ABIS } from "./constants.js";
import { delayedRugCheck } from "./delayRugCheck.js";
import {
  BI,
  biAdd,
  biSub,
  biMul,
  biDiv,
  biGte,
  biLte,
  biStr
} from "./bigintSafe.js";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_8, process.env.RPC_URL_9].filter(Boolean);
if (!RPC_URLS.length) throw new Error("No RPC URLs configured");

const FORK_RPC = process.env.FORK_RPC || "http://127.0.0.1:8545";
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 5, concurrency: 3 });
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

/* ================= CONSTANTS ================= */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
function loadAddr(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing env var: ${name}`);
    process.exit(1);
  }
  if (!ethers.isAddress(v)) {
    console.error(`❌ Invalid address in ${name}: ${v}`);
    process.exit(1);
  }
  return v.toLowerCase();
}

const WBNB    = loadAddr("WBNB_ADDRESS");
const ROUTER  = loadAddr("PANCAKE_ROUTER");
const FACTORY = loadAddr("PANCAKE_FACTORY");

/* ================= ABIs ================= */
const FACTORY_ABI = [
  { name: "getPair", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] }
];

const PAIR_ABI = [
  { name:"getReserves", type:"function", stateMutability:"view", outputs:[{type:"uint112"},{type:"uint112"},{type:"uint32"}] },
  { name:"totalSupply", type:"function", stateMutability:"view", outputs:[{type:"uint256"}] },
  { name:"balanceOf", type:"function", stateMutability:"view", inputs:[{type:"address"}], outputs:[{type:"uint256"}] },
  { name:"token0", type:"function", stateMutability:"view", outputs:[{type:"address"}] },
  { name:"token1", type:"function", stateMutability:"view", outputs:[{type:"address"}] }
];
/* ================= DEV MEMORY ================= */
const devMemory = {};

/* ================= HELPERS ================= */
function validateToken(token) {
  try { return ethers.isAddress(token); } catch { return false; }
}

/* ================= DEV WALLET ================= */
export async function getDevWallet(token) {
  return safeRpcCall(async (web3) => {
    try {
      const LOOKBACK = 28800 * 3; // ~3 days
      const latest = Number(await web3.eth.getBlockNumber());

      const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0;

      const logs = await web3.eth.getPastLogs({
        address: token,
        topics: [
          // Transfer(address,address,uint256)
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
        ],
        fromBlock,
        toBlock: "latest"
      }).catch(() => []);

      if (!Array.isArray(logs) || logs.length === 0) {
        return null;
      }

      // Mint = from ZERO_ADDR
      const mintLog = logs.find(
        l =>
          l?.topics &&
          l.topics.length >= 3 &&
          l.topics[1]?.toLowerCase() === ZERO_ADDR
      );

      if (!mintLog) return null;

      // Extract `to` address (last 20 bytes)
      const dev =
        "0x" + mintLog.topics[2].slice(-40);

      return dev.toLowerCase();
    } catch {
      return null;
    }
  });
}

/* ================= LP OWNERSHIP ================= */
export async function checkLpOwner(token) {
  const web3 = new Web3(FORK_RPC);
  const deployer = await getDevWallet(token);

  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
  const pairAddr = await factory.methods.getPair(token, WBNB).call();

  if (!pairAddr || pairAddr === ZERO_ADDR) {
    return {
      lpExists: false,
      totalScore: "0",
      metrics: { lpBurnedPercent: "0", devLpPercent: "0", lockedPercent: "0" },
      rug: null
    };
  }

  const lp = new web3.eth.Contract(PAIR_ABI, pairAddr);
  const totalSupply = BI(await lp.methods.totalSupply().call());

  if (totalSupply === 0n) {
    return {
      lpExists: false,
      totalScore: "0",
      metrics: { lpBurnedPercent: "0", devLpPercent: "0", lockedPercent: "0" },
      rug: null
    };
  }

  /* ---------- BALANCES ---------- */
  const burnBalance = biAdd(
    BI(await lp.methods.balanceOf(ZERO_ADDR).call()),
    BI(await lp.methods.balanceOf("0x000000000000000000000000000000000000dEaD").call())
  );

  const devBalance = deployer
    ? BI(await lp.methods.balanceOf(deployer).call())
    : 0n;

  /* ---------- LOCKS ---------- */
  let lockedAmount = 0n, lockOwner, lockExpiry, splitLock = false;

  for (const lockerDef of LOCKER_ABIS) {
    try {
      const locker = new web3.eth.Contract(lockerDef.abi, lockerDef.address);
      const lockRaw = await locker.methods.getLockInfo(pairAddr).call();

      const amount = BI(lockRaw?.amount);
      if (amount > 0n) {
        if (!lockOwner) {
          lockOwner = lockRaw.owner?.toLowerCase();
          lockExpiry = BI(lockRaw.expiry);
          lockedAmount = biAdd(lockedAmount, amount);
        } else {
          splitLock = true;
          lockedAmount = biAdd(lockedAmount, amount);
        }
      }
    } catch {}
  }

  /* ---------- PERCENTS ---------- */
  const SCALE = 100_000n;
  const lpBurnedPercent = biDiv(biMul(burnBalance, SCALE), totalSupply);
  const devLpPercent = biDiv(biMul(devBalance, SCALE), totalSupply);
  const lockedPercent = biDiv(biMul(lockedAmount, SCALE), totalSupply);

  /* ---------- LOCK QUALITY ---------- */
  const now = BI(Math.floor(Date.now() / 1000));
  const minLock = biMul(30n, biMul(24n, 3600n));
  const lockLongEnough = lockExpiry ? biGte(biSub(lockExpiry, now), minLock) : false;
  const ownerIsNotDeployer = !!(lockOwner && deployer && lockOwner !== deployer.toLowerCase());

  /* ---------- SCORE ---------- */
  let lpScore = 0n;
  if (biGte(lpBurnedPercent, 95_000n) || biGte(lockedPercent, 90_000n)) lpScore = biAdd(lpScore, 25n);
  if (lockLongEnough) lpScore = biAdd(lpScore, 25n);
  if (biLte(devLpPercent, 500n)) lpScore = biAdd(lpScore, 25n);
  if (ownerIsNotDeployer) lpScore = biAdd(lpScore, 25n);
  if (!splitLock) lpScore = biAdd(lpScore, 25n);

  /* ---------- RUG PENALTY ---------- */
  const rug = await delayedRugCheck(token, FORK_RPC);
  if (rug?.verdict === "DELAYED_RUG_LIKELY") {
    lpScore = biSub(lpScore, 25n);
    if (lpScore < 0n) lpScore = 0n;
  }

  return {
    lpExists: true,
    metrics: {
      lpBurnedPercent: biStr(lpBurnedPercent),
      devLpPercent: biStr(devLpPercent),
      lockedPercent: biStr(lockedPercent),
      lockExpiry: lockExpiry ? biStr(lockExpiry) : undefined,
      lockOwner,
      splitLock
    },
    rug,
    totalScore: biStr(lpScore)
  };
}
/* ===========================================================
   🔹 FORK SELL SIMULATION (BIGINT-SAFE & Web3/Ethers compatible)
=========================================================== */
export async function forkSellSimulation(token) {
  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const wallet = ethers.Wallet.createRandom().connect(provider);

  // fund wallet
  await provider.send("hardhat_setBalance", [
    wallet.address,
    "0x1000000000000000000"
  ]);

  const router = new ethers.Contract(
    ROUTER,
    [
      "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint,address[],address,uint) payable",
      "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint,uint,address[],address,uint)"
    ],
    wallet
  );

  const tokenC = new ethers.Contract(
    token,
    [
      "function approve(address,uint256)",
      "function balanceOf(address) view returns(uint256)"
    ],
    wallet
  );

  const deadlineBI = biAdd(BI(Math.floor(Date.now() / 1000)), 60n);
  const deadline = Number(deadlineBI); // required by ethers for deadline param
  const ethIn = BI(ethers.parseEther("0.01"));

  /* ---------- RESERVES ---------- */
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(token, WBNB);
  if (!pairAddress || pairAddress === ZERO_ADDR) return { ok: false, honeypot: true, reason: "NO_PAIR" };

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const tokenReserve = BI(token0 === token.toLowerCase() ? reserves[0] : reserves[1]);
  const wbnbReserve = BI(token0 === token.toLowerCase() ? reserves[1] : reserves[0]);

  if (tokenReserve === 0n || wbnbReserve === 0n) return { ok: false, honeypot: true, reason: "EMPTY_LP" };

  /* ---------- BUY ---------- */
  try {
    await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0,
      [WBNB, token],
      wallet.address,
      deadline,
      { value: ethIn }
    );
  } catch {
    return { ok: false, honeypot: true, reason: "BUY_FAILED" };
  }

  const tokenBalance = BI(await tokenC.balanceOf(wallet.address));
  if (tokenBalance === 0n) return { ok: false, honeypot: true, reason: "NO_TOKENS_RECEIVED" };

  /* ---------- BUY TAX ---------- */
  const expectedBuyOut = biDiv(
    biMul(biMul(ethIn, tokenReserve), 9975n),
    biAdd(biMul(wbnbReserve, 10000n), biMul(ethIn, 9975n))
  );

  const buyTaxPercent = expectedBuyOut > tokenBalance
    ? biPct(biSub(expectedBuyOut, tokenBalance), expectedBuyOut)
    : 0n;

  if (buyTaxPercent > 10n) return { ok: false, honeypot: true, reason: `HIGH_BUY_TAX_${biStr(buyTaxPercent)}%` };

  await tokenC.approve(ROUTER, biStr(tokenBalance));

  /* ---------- SELL ---------- */
  const bnbBefore = BI(await provider.getBalance(wallet.address));

  try {
    await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      biStr(tokenBalance),
      0,
      [token, WBNB],
      wallet.address,
      deadline
    );
  } catch {
    return { ok: false, honeypot: true, reason: "SELL_REVERT" };
  }

  const bnbAfter = BI(await provider.getBalance(wallet.address));
  const actualOut = biSub(bnbAfter, bnbBefore);

  const expectedOut = biDiv(
    biMul(biMul(tokenBalance, wbnbReserve), 9975n),
    biAdd(biMul(tokenReserve, 10000n), biMul(tokenBalance, 9975n))
  );

  const sellTaxPercent = expectedOut > actualOut
    ? biPct(biSub(expectedOut, actualOut), expectedOut)
    : 0n;

  if (sellTaxPercent === 0n) return { ok: true, honeypot: false, reason: "ZERO_TAX" };
  if (sellTaxPercent > 90n) return { ok: false, honeypot: true, reason: "HIGH_SELL_TAX" };

  return { ok: false, honeypot: true, reason: `SELL_TAX_${biStr(sellTaxPercent)}%` };
}
/* ===========================================================
   🔹 SWAP FEE CHECK (BIGINT-SAFE & Web3 compatible)
=========================================================== */
 export async function swapFeeCheck(token) {
  const web3 = new Web3(FORK_RPC);
  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);

  const pairAddress = await factory.methods.getPair(token, WBNB).call();
  if (!pairAddress || pairAddress === ZERO_ADDR) {
    return { ok: false, priceImpactPercent: "0" };
  }

  const pair = new web3.eth.Contract(PAIR_ABI, pairAddress);
  const reserves = await pair.methods.getReserves().call();
  const token0 = (await pair.methods.token0().call()).toLowerCase();

  const reserve0 = BI(reserves[0]);
  const reserve1 = BI(reserves[1]);

  const tokenReserve = token0 === token.toLowerCase() ? reserve0 : reserve1;

  if (tokenReserve === 0n) {
    return { ok: false, priceImpactPercent: "0" };
  }

  // simulate a tiny swap (0.1% of reserve)
  const amountIn = biDiv(tokenReserve, 1000n);
  if (amountIn === 0n) {
    return { ok: false, priceImpactPercent: "0" };
  }

  const priceImpactPercent = biDiv(biMul(amountIn, 100n), biAdd(tokenReserve, amountIn));

  return {
    ok: true,
    priceImpactPercent: biStr(priceImpactPercent)
  };
}
/* ===========================================================
   🔹 WALLET RATE (BIGINT-SAFE)
=========================================================== */
export async function walletRate(token) {
  if (!validateToken(token)) {
    return {
      token,
      totalScore: "0",
      health: "unhealthy",
      details: { reason: "Invalid token" }
    };
  }

  const result = {
    token,
    totalScore: "0",
    health: "unhealthy",
    details: {
      lpOwnership: { score: "0", status: "unhealthy" },
      sellSimulation: { score: "0", status: "unhealthy" },
      swapFee: { score: "0", status: "unhealthy" },
      devWallet: { score: "0", status: "unhealthy" }
    }
  };

  let totalScoreBI = 0n;

  /* ================= LP OWNERSHIP ================= */
  const lp = await checkLpOwner(token);
  if (lp.lpExists) {
    let lpScoreBI = BI(lp.totalScore);
    lpScoreBI = biMin(lpScoreBI, 125n); // clamp to max 125

    result.details.lpOwnership = {
      score: biStr(lpScoreBI),
      status: biGte(lpScoreBI, 100n) ? "healthy" : "unhealthy",
      metrics: lp.metrics,
      rug: lp.rug
    };

    totalScoreBI = biAdd(totalScoreBI, lpScoreBI);
  }

  /* ================= SELL SIMULATION ================= */
  const sell = await forkSellSimulation(token);
  if (sell.ok) {
    result.details.sellSimulation = {
      score: "20",
      status: "healthy",
      honeypot: !!sell.honeypot
    };
    totalScoreBI = biAdd(totalScoreBI, 20n);
  } else {
    result.details.sellSimulation = {
      score: "0",
      status: "unhealthy",
      reason: sell.reason
    };
  }

  /* ================= SWAP FEE ================= */
  const fee = await swapFeeCheck(token);
  const feePercentBI = BI(fee?.priceImpactPercent || 0n);

  if (fee.ok && biLte(feePercentBI, 10n)) {
    result.details.swapFee = {
      score: "15",
      status: "healthy",
      feePercent: biStr(feePercentBI)
    };
    totalScoreBI = biAdd(totalScoreBI, 15n);
  }

  /* ================= DEV WALLET ================= */
  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) {
    result.details.devWallet = {
      score: "15",
      status: "healthy"
    };
    totalScoreBI = biAdd(totalScoreBI, 15n);
  }

  /* ================= FINAL ================= */
  result.totalScore = biStr(totalScoreBI);
  result.health = biGte(totalScoreBI, 130n) ? "healthy" : "unhealthy";

  return result;
}