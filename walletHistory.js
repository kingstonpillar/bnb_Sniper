import dotenv from 'dotenv';
dotenv.config();

import { ethers } from "ethers";
import Web3 from "web3";
import PQueue from "p-queue";
import { LOCKER_ABIS } from "./constants.js";
import { delayedRugCheck } from "./delayRugCheck.js";

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
const WBNB = process.env.WBNB_ADDRESS.toLowerCase();
const ROUTER = process.env.PANCAKE_ROUTER.toLowerCase();
const FACTORY = process.env.PANCAKE_FACTORY.toLowerCase();

if (!WBNB || !FACTORY || !ROUTER) {
  console.error("❌ Missing required environment variables!");
  process.exit(1);
}

/* ================= ABIs ================= */
const FACTORY_ABI = [
  { name: "getPair", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] }
];

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }
];

const PAIR_ABI = [
  { name: "getReserves", type: "function", stateMutability: "view", outputs:[{ type:"uint112" },{ type:"uint112" },{ type:"uint32" }]},
  { name:"totalSupply", type:"function", stateMutability:"view", outputs:[{type:"uint256"}]},
  { name:"token0",type:"function",stateMutability:"view",outputs:[{type:"address"}]},
  { name:"token1",type:"function",stateMutability:"view",outputs:[{type:"address"}]}
];



/* ================= DEV MEMORY ================= */
const devMemory = {};

/* ================= HELPERS ================= */
function validateToken(token) {
  try { return ethers.isAddress(token); } catch { return false; }
}

/* ================= DEV WALLET ================= */
export async function getDevWallet(token) {
  return safeRpcCall(async web3 => {
    const LOOKBACK = 28800 * 3;
    const latest = await web3.eth.getBlockNumber();
    const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0;
    const logs = await web3.eth.getPastLogs({
      address: token,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      fromBlock, toBlock: "latest"
    }).catch(() => []);

    const mint = logs.find(l => l.topics[1] === ZERO_ADDR);
    if (!mint) return null;
    return ("0x" + mint.topics[2].slice(26)).toLowerCase();
  });
}

/* ================= LP OWNERSHIP ================= */
export async function checkLpOwner(token) {
  const web3 = new Web3(FORK_RPC);

  // 1️⃣ Resolve deployer
  const deployer = await getDevWallet(token);

  // 2️⃣ Resolve LP pair
  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
  const pairAddr = await factory.methods.getPair(token, WBNB).call();
  if (!pairAddr || pairAddr === ZERO_ADDR) {
    return { lpExists: false, totalScore: 0n, metrics: { lpBurnedPercent: 0n, devLpPercent: 0n }, rug: null };
  }

  const lp = new web3.eth.Contract(PAIR_ABI, pairAddr);
  const totalSupply = BigInt(await lp.methods.totalSupply().call());
  if (totalSupply === 0n) {
    return { lpExists: false, totalScore: 0n, metrics: { lpBurnedPercent: 0n, devLpPercent: 0n }, rug: null };
  }

  // 3️⃣ LP balances
  const burnBalance =
    BigInt(await lp.methods.balanceOf(ZERO_ADDR).call()) +
    BigInt(await lp.methods.balanceOf("0x000000000000000000000000000000000000dEaD").call());
  const devBalance = deployer ? BigInt(await lp.methods.balanceOf(deployer).call()) : 0n;

  let lockedAmount = 0n;
  let lockOwner = undefined;
  let lockExpiry = undefined;
  let splitLock = false;

  // 4️⃣ Real locker detection
  for (const lockerDef of LOCKER_ABIS) {
    try {
      const locker = new web3.eth.Contract(lockerDef.abi, lockerDef.address);
      const lock = await locker.methods.getLockInfo(pairAddr).call();
      if (lock && BigInt(lock.amount) > 0n) {
        if (!lockOwner) {
          lockOwner = lock.owner.toLowerCase();
          lockExpiry = BigInt(lock.expiry);
          lockedAmount += BigInt(lock.amount);
        } else {
          splitLock = true;
          lockedAmount += BigInt(lock.amount);
        }
      }
    } catch { continue; }
  }

  // 5️⃣ Percentages as BigInt scaled (3 decimals, 100% = 100000n)
  const SCALE = 100_000n;
  const lpBurnedPercent = (burnBalance * SCALE) / totalSupply;
  const devLpPercent = (devBalance * SCALE) / totalSupply;
  const lockedPercent = (lockedAmount * SCALE) / totalSupply;

  // 6️⃣ Control checks
let lockLongEnough = false;
if (lockExpiry !== undefined) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  lockLongEnough = (lockExpiry - now) >= (30n * 24n * 3600n);
}

const ownerIsNotDeployer =
  !!(lockOwner && deployer && lockOwner !== deployer.toLowerCase());
  

  // 7️⃣ LP safety scoring
  let lpScore = 0n;
  if (lpBurnedPercent >= 95_000n || lockedPercent >= 90_000n) lpScore += 25n; // 95% & 90% thresholds
  if (lockLongEnough) lpScore += 25n;
  if (devLpPercent <= 500n) lpScore += 25n; // 0.5% threshold
  if (ownerIsNotDeployer) lpScore += 25n;
  if (!splitLock) lpScore += 25n;

  // 8️⃣ Delayed rug scan
  const rug = await delayedRugCheck(token, FORK_RPC);
  const rugScore = rug.verdict === "DELAYED_RUG_LIKELY" ? 0n : 25n;

  const totalScore = lpScore + rugScore;

  return {
    lpExists: true,
    metrics: { lpBurnedPercent, devLpPercent, lockedPercent, lockExpiry, lockOwner, splitLock },
    rug,
    totalScore
  };
}
/* ================= SWAP FEE (ALL BIGINT) ================= */
export async function swapFeeCheck(token) {
  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

  const pairAddress = await factory.getPair(token, WBNB);
  if (!pairAddress || pairAddress === ZERO_ADDR) {
    return { ok: false };
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const tokenReserve =
    token0 === token.toLowerCase()
      ? BigInt(reserves[0])
      : BigInt(reserves[1]);

  if (tokenReserve === 0n) {
    return { ok: false };
  }

  // Trade size: 0.1% of token liquidity
  const amountIn = tokenReserve / 1000n;
  if (amountIn === 0n) {
    return { ok: false };
  }

  // Price impact ≈ trade size vs liquidity
  // scaled: 100% = 100n
  const priceImpactPercent =
    (amountIn * 100n) / (tokenReserve + amountIn);

  return {
    ok: true,
    priceImpactPercent
  };
}

/* ================= FORK SELL SIMULATION (ALL BIGINT) ================= */
export async function forkSellSimulation(token) {
  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const wallet = ethers.Wallet.createRandom().connect(provider);

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

  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 60n;
  const ethIn = ethers.parseEther("0.01");

  /* ---------- RESERVES BEFORE BUY ---------- */
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(token, WBNB);
  if (!pairAddress || pairAddress === ZERO_ADDR) {
    return { ok:false, honeypot:true, reason:"NO_PAIR" };
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const tokenReserve =
    token0 === token.toLowerCase()
      ? BigInt(reserves[0])
      : BigInt(reserves[1]);

  const wbnbReserve =
    token0 === token.toLowerCase()
      ? BigInt(reserves[1])
      : BigInt(reserves[0]);

  if (tokenReserve === 0n || wbnbReserve === 0n) {
    return { ok:false, honeypot:true, reason:"EMPTY_LP" };
  }

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
    return { ok:false, honeypot:true, reason:"BUY_FAILED" };
  }

  const tokenBalance = BigInt(await tokenC.balanceOf(wallet.address));
  if (tokenBalance === 0n) {
    return { ok:false, honeypot:true, reason:"NO_TOKENS_RECEIVED" };
  }

  /* ---------- BUY TAX (BigInt safe) ---------- */
  const ethInBI = BigInt(ethIn);

  const expectedBuyOut =
    (ethInBI * tokenReserve * 9975n) /
    (wbnbReserve * 10000n + ethInBI * 9975n);

  if (expectedBuyOut === 0n) {
    return { ok:false, honeypot:true, reason:"ZERO_EXPECTED_BUY" };
  }

  // ✅ Bulletproof buy tax
  let buyTaxPercent = 0n;
  if (expectedBuyOut > tokenBalance) {
    buyTaxPercent = ((expectedBuyOut - tokenBalance) * 100n) / expectedBuyOut;
  }

  if (buyTaxPercent > 10n) {
    return {
      ok:false,
      honeypot:true,
      reason:`HIGH_BUY_TAX_${buyTaxPercent.toString()}%`
    };
  }

  await tokenC.approve(ROUTER, tokenBalance);

  /* ---------- SELL ---------- */
  const bnbBefore = await provider.getBalance(wallet.address);

  try {
    await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenBalance,
      0,
      [token, WBNB],
      wallet.address,
      deadline
    );
  } catch {
    return { ok:false, honeypot:true, reason:"SELL_REVERT" };
  }

  const bnbAfter = await provider.getBalance(wallet.address);
  const actualOut = bnbAfter - bnbBefore;

  const expectedOut =
    (tokenBalance * wbnbReserve * 9975n) /
    (tokenReserve * 10000n + tokenBalance * 9975n);

  if (expectedOut === 0n) {
    return { ok:false, honeypot:true, reason:"ZERO_EXPECTED_OUT" };
  }

  // ✅ Bulletproof sell tax
  let sellTaxPercent = 0n;
  if (expectedOut > actualOut) {
    sellTaxPercent = ((expectedOut - actualOut) * 100n) / expectedOut;
  }

  if (sellTaxPercent === 0n) {
    return { ok:true, honeypot:false, reason:"ZERO_TAX" };
  } else if (sellTaxPercent > 90n) {
    return { ok:false, honeypot:true, reason:"HIGH_SELL_TAX" };
  } else {
    return {
      ok:false,
      honeypot:true,
      reason:`SELL_TAX_${sellTaxPercent.toString()}%`
    };
  }
}
/* ================= WALLET RATE (ALL BIGINT SAFE) =================
   Calculates safety and health score based on LP ownership,
   sell simulation, swap fee, and dev wallet.
================================================================== */
export async function walletRate(token) {
  if (!validateToken(token)) return {
    token,
    totalScore: 0n,
    health: "unhealthy",
    details: { reason: "Invalid token" }
  };

  const result = {
    token,
    totalScore: 0n,
    health: "unhealthy",
    details: {
      lpOwnership: { score: 0n, status: "unhealthy" },
      sellSimulation: { score: 0n, status: "unhealthy" },
      swapFee: { score: 0n, status: "unhealthy" },
      devWallet: { score: 0n, status: "unhealthy" }
    }
  };

  // 1️⃣ LP Ownership
  const lp = await checkLpOwner(token);
  if (lp.lpExists) {
    const lpScore = lp.totalScore > 125n ? 125n : lp.totalScore;

    // Use lpScore consistently in all comparisons
    const lpStatus = lpScore >= 100n ? "healthy" : "unhealthy";

    result.details.lpOwnership = {
      score: lpScore,
      status: lpStatus,
      metrics: lp.metrics,
      rug: lp.rug
    };

    result.totalScore += lpScore;
  }

  // 2️⃣ Sell Simulation
  const sell = await forkSellSimulation(token);
  if (sell.ok) {
    result.details.sellSimulation = { score: 20n, status: "healthy", honeypot: sell.honeypot };
    result.totalScore += 20n;
  } else {
    result.details.sellSimulation = { score: 0n, status: "unhealthy", reason: sell.reason };
  }

  
  // 3️⃣ Swap Fee
const fee = await swapFeeCheck(token);
if (fee.ok && fee.feePercent <= 10n) {
  result.details.swapFee = {
    score: 15n,
    status: "healthy",
    feePercent: fee.feePercent
  };
  result.totalScore += 15n;
}
  // 4️⃣ Dev Wallet
  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) {
    result.details.devWallet = { score: 15n, status: "healthy" };
    result.totalScore += 15n;
  }

  // ✅ Health based on total score threshold (130n)
  result.health = result.totalScore >= 130n ? "healthy" : "unhealthy";

  return result;
}