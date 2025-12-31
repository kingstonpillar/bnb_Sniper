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
  const totalSupply = BigInt(await lp.methods.totalSupply().call() || "0");
  if (totalSupply === 0n) {
    return {
      lpExists: false,
      totalScore: "0",
      metrics: { lpBurnedPercent: "0", devLpPercent: "0", lockedPercent: "0" },
      rug: null
    };
  }

  const burnBalance = BigInt(await lp.methods.balanceOf(ZERO_ADDR).call() || "0") +
                      BigInt(await lp.methods.balanceOf("0x000000000000000000000000000000000000dEaD").call() || "0");

  const devBalance = deployer ? BigInt(await lp.methods.balanceOf(deployer).call() || "0") : 0n;

  let lockedAmount = 0n, lockOwner, lockExpiry, splitLock = false;
  for (const lockerDef of LOCKER_ABIS) {
    try {
      const locker = new web3.eth.Contract(lockerDef.abi, lockerDef.address);
      const lockRaw = await locker.methods.getLockInfo(pairAddr).call();
      if (lockRaw && BigInt(lockRaw.amount || "0") > 0n) {
        if (!lockOwner) {
          lockOwner = lockRaw.owner?.toLowerCase();
          lockExpiry = BigInt(lockRaw.expiry || "0");
          lockedAmount += BigInt(lockRaw.amount || "0");
        } else {
          splitLock = true;
          lockedAmount += BigInt(lockRaw.amount || "0");
        }
      }
    } catch {}
  }

  const SCALE = 100_000n;
  const lpBurnedPercent = (burnBalance * SCALE) / totalSupply;
  const devLpPercent = (devBalance * SCALE) / totalSupply;
  const lockedPercent = (lockedAmount * SCALE) / totalSupply;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const lockLongEnough = lockExpiry ? (lockExpiry - now) >= (30n * 24n * 3600n) : false;
  const ownerIsNotDeployer = !!(lockOwner && deployer && lockOwner !== deployer.toLowerCase());

  
let lpScore = 0n;
  if (lpBurnedPercent >= 95_000n || lockedPercent >= 90_000n) lpScore += 25n;
  if (lockLongEnough) lpScore += 25n;
  if (devLpPercent <= 500n) lpScore += 25n;
  if (ownerIsNotDeployer) lpScore += 25n;
  if (!splitLock) lpScore += 25n;

  // 🔴 APPLY RUG PENALTY HERE (ONCE)
  const rug = await delayedRugCheck(token, FORK_RPC);
  if (rug?.verdict === "DELAYED_RUG_LIKELY") {
    lpScore -= 25n;
    if (lpScore < 0n) lpScore = 0n;
  }

  return {
    lpExists: true,
    metrics: {
      lpBurnedPercent: lpBurnedPercent.toString(),
      devLpPercent: devLpPercent.toString(),
      lockedPercent: lockedPercent.toString(),
      lockExpiry: lockExpiry?.toString(),
      lockOwner,
      splitLock
    },
    rug,                      // info only
    totalScore: lpScore.toString()
  };
} // ✅ CLOSE THE FUNCTION
/* ===========================================================
   🔹 FORK SELL SIMULATION (BIGINT-SAFE & Web3/Ethers compatible)
=========================================================== */
export async function forkSellSimulation(token) {
  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const wallet = ethers.Wallet.createRandom().connect(provider);

  // Fund the wallet (Ethers expects hex string)
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
  const ethIn = ethers.parseEther("0.01"); // BigInt

  // ---------- RESERVES ----------
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(token, WBNB);
  if (!pairAddress || pairAddress === ZERO_ADDR) return { ok:false, honeypot:true, reason:"NO_PAIR" };

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const tokenReserve = token0 === token.toLowerCase() ? BigInt(reserves[0].toString()) : BigInt(reserves[1].toString());
  const wbnbReserve = token0 === token.toLowerCase() ? BigInt(reserves[1].toString()) : BigInt(reserves[0].toString());

  if (tokenReserve === 0n || wbnbReserve === 0n) return { ok:false, honeypot:true, reason:"EMPTY_LP" };

  // ---------- BUY ----------
  try {
    await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0, // pass 0 as number/string, not BigInt
      [WBNB, token],
      wallet.address,
      Number(deadline), // convert BigInt to Number
      { value: ethIn }
    );
  } catch {
    return { ok:false, honeypot:true, reason:"BUY_FAILED" };
  }

  const tokenBalance = BigInt((await tokenC.balanceOf(wallet.address)).toString());
  if (tokenBalance === 0n) return { ok:false, honeypot:true, reason:"NO_TOKENS_RECEIVED" };

  // ---------- BUY TAX ----------
  const expectedBuyOut = (ethIn * tokenReserve * 9975n) / (wbnbReserve * 10000n + ethIn * 9975n);
  const buyTaxPercent = expectedBuyOut > tokenBalance ? ((expectedBuyOut - tokenBalance) * 100n) / expectedBuyOut : 0n;
  if (buyTaxPercent > 10n) return { ok:false, honeypot:true, reason:`HIGH_BUY_TAX_${buyTaxPercent}%` };

  await tokenC.approve(ROUTER, tokenBalance.toString()); // must be string

  // ---------- SELL ----------
  const bnbBefore = BigInt((await provider.getBalance(wallet.address)).toString());
  try {
    await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenBalance.toString(), // must be string
      0,                       // number/string
      [token, WBNB],
      wallet.address,
      Number(deadline)
    );
  } catch {
    return { ok:false, honeypot:true, reason:"SELL_REVERT" };
  }

  const bnbAfter = BigInt((await provider.getBalance(wallet.address)).toString());
  const actualOut = bnbAfter - bnbBefore;
  const expectedOut = (tokenBalance * wbnbReserve * 9975n) / (tokenReserve * 10000n + tokenBalance * 9975n);

  const sellTaxPercent = expectedOut > actualOut ? ((expectedOut - actualOut) * 100n) / expectedOut : 0n;

  if (sellTaxPercent === 0n) return { ok:true, honeypot:false, reason:"ZERO_TAX" };
  if (sellTaxPercent > 90n) return { ok:false, honeypot:true, reason:"HIGH_SELL_TAX" };
  return { ok:false, honeypot:true, reason:`SELL_TAX_${sellTaxPercent}%` };
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

  const reserve0 = BigInt(reserves[0].toString());
  const reserve1 = BigInt(reserves[1].toString());

  const tokenReserve =
    token0 === token.toLowerCase() ? reserve0 : reserve1;

  if (tokenReserve === 0n) {
    return { ok: false, priceImpactPercent: "0" };
  }

  // simulate a tiny swap (0.1% of reserve)
  const amountIn = tokenReserve / 1000n;
  if (amountIn === 0n) {
    return { ok: false, priceImpactPercent: "0" };
  }

  const priceImpactPercent =
    (amountIn * 100n) / (tokenReserve + amountIn);

  return {
    ok: true,
    priceImpactPercent: priceImpactPercent.toString()
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
  let lpScoreBI = BigInt(lp.totalScore);
  if (lpScoreBI > 125n) lpScoreBI = 125n;

  result.details.lpOwnership = {
    score: lpScoreBI.toString(),
    status: lpScoreBI >= 100n ? "healthy" : "unhealthy",
    metrics: lp.metrics,
    rug: lp.rug
  };

  totalScoreBI += lpScoreBI;
}

  /* ================= SELL SIMULATION ================= */
  const sell = await forkSellSimulation(token);
  if (sell.ok) {
    result.details.sellSimulation = {
      score: "20",
      status: "healthy",
      honeypot: !!sell.honeypot
    };
    totalScoreBI += 20n;
  } else {
    result.details.sellSimulation = {
      score: "0",
      status: "unhealthy",
      reason: sell.reason
    };
  }

  /* ================= SWAP FEE ================= */
  const fee = await swapFeeCheck(token);
  const feePercentBI = BigInt(fee?.priceImpactPercent || "0");

  if (fee.ok && feePercentBI <= 10n) {
    result.details.swapFee = {
      score: "15",
      status: "healthy",
      feePercent: feePercentBI.toString()
    };
    totalScoreBI += 15n;
  }

  /* ================= DEV WALLET ================= */
  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) {
    result.details.devWallet = {
      score: "15",
      status: "healthy"
    };
    totalScoreBI += 15n;
  }

  /* ================= FINAL ================= */
  result.totalScore = totalScoreBI.toString();
  result.health = totalScoreBI >= 130n ? "healthy" : "unhealthy";

  return result;
}