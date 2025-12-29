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

interface LPResult {
  lpExists: boolean;
  metrics: {
    lpBurnedPercent: number;
    devLpPercent: number;
    lockExpiry?: number;
    lockOwner?: string;
    splitLock?: boolean;
  };
  rug: any;
  totalScore: number;
}

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
export async function checkLpOwner(token: string): Promise<LPResult> {
  const web3 = new Web3(FORK_RPC);

  /* -------------------------------------------------
     1️⃣ Resolve deployer (AUTOMATIC, on-chain)
  ------------------------------------------------- */
  const deployer = await getDevWallet(token); // mint tx ZERO → deployer

  /* -------------------------------------------------
     2️⃣ Resolve LP pair
  ------------------------------------------------- */
  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
  const pairAddr = await factory.methods.getPair(token, WBNB).call();

  if (!pairAddr || pairAddr === ZERO_ADDR) {
    return {
      lpExists: false,
      totalScore: 0,
      metrics: { lpBurnedPercent: 0, devLpPercent: 0 },
      rug: null
    };
  }

  const lp = new web3.eth.Contract(PAIR_ABI, pairAddr);

  const totalSupply = BigInt(await lp.methods.totalSupply().call());
  if (totalSupply === 0n) {
    return {
      lpExists: false,
      totalScore: 0,
      metrics: { lpBurnedPercent: 0, devLpPercent: 0 },
      rug: null
    };
  }

  /* -------------------------------------------------
     3️⃣ LP balances (ground truth)
  ------------------------------------------------- */
  const burnBalance =
    BigInt(await lp.methods.balanceOf(ZERO_ADDR).call()) +
    BigInt(await lp.methods.balanceOf("0x000000000000000000000000000000000000dEaD").call());

  const devBalance = deployer
    ? BigInt(await lp.methods.balanceOf(deployer).call())
    : 0n;

  let lockedAmount = 0n;
  let lockOwner: string | undefined;
  let lockExpiry: number | undefined;
  let splitLock = false;

  /* -------------------------------------------------
     4️⃣ Real locker detection (Unicrypt / Pink / Team)
  ------------------------------------------------- */
  for (const lockerDef of LOCKER_ABIS) {
    try {
      const locker = new web3.eth.Contract(lockerDef.abi, lockerDef.address);
      const lock = await locker.methods.getLockInfo(pairAddr).call();

      if (lock && BigInt(lock.amount) > 0n) {
        if (!lockOwner) {
          lockOwner = lock.owner.toLowerCase();
          lockExpiry = Number(lock.expiry);
          lockedAmount += BigInt(lock.amount);
        } else {
          splitLock = true; // multiple lockers = risk
          lockedAmount += BigInt(lock.amount);
        }
      }
    } catch {
      continue;
    }
  }

  /* -------------------------------------------------
     5️⃣ Percentages
  ------------------------------------------------- */
  const lpBurnedPercent = Number((burnBalance * 100n) / totalSupply);
  const devLpPercent = Number((devBalance * 100n) / totalSupply);
  const lockedPercent = Number((lockedAmount * 100n) / totalSupply);

  /* -------------------------------------------------
     6️⃣ Control checks (CRITICAL)
  ------------------------------------------------- */
  const lockLongEnough =
    lockExpiry && lockExpiry - Math.floor(Date.now() / 1000) >= 30 * 24 * 3600;

  const ownerIsNotDeployer =
    lockOwner && deployer && lockOwner !== deployer.toLowerCase();

  /* -------------------------------------------------
     7️⃣ LP safety scoring (max 125)
  ------------------------------------------------- */
  let lpScore = 0;

  // LP burned ≥95% OR locked ≥90%
  if (lpBurnedPercent >= 95 || lockedPercent >= 90) lpScore += 25;

  // Lock duration ≥30 days
  if (lockLongEnough) lpScore += 25;

  // Dev LP ≤0.5%
  if (devLpPercent <= 0.5) lpScore += 25;

  // Lock owner ≠ deployer
  if (ownerIsNotDeployer) lpScore += 25;

  // No split locks
  if (!splitLock) lpScore += 25;

  /* -------------------------------------------------
     8️⃣ Delayed rug capability scan (fork bytecode)
  ------------------------------------------------- */
  const rug = await delayedRugCheck(token, FORK_RPC);
  const rugScore = rug.verdict === "DELAYED_RUG_LIKELY" ? 0 : 25;

  const totalScore = lpScore + rugScore;

  /* -------------------------------------------------
     9️⃣ Final result
  ------------------------------------------------- */
  return {
    lpExists: true,
    metrics: {
      lpBurnedPercent,
      devLpPercent,
      lockExpiry,
      lockOwner,
      splitLock
    },
    rug,
    totalScore
  };
}
/* ================= SWAP FEE (SLIPPAGE + GAS + TAX) ================= */
export async function swapFeeCheck(token) {
  const forkProvider = new ethers.JsonRpcProvider(FORK_RPC);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, forkProvider);
  const pairAddress = await factory.getPair(token, WBNB);
  if (!pairAddress || pairAddress === ZERO_ADDR) return { ok:false };

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, forkProvider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const tokenReserve = token0 === token.toLowerCase() ? BigInt(reserves[0]) : BigInt(reserves[1]);
  const wbnbReserve = token0 === token.toLowerCase() ? BigInt(reserves[1]) : BigInt(reserves[0]);

  if (tokenReserve === 0n || wbnbReserve === 0n) return { ok:false };

  // Simulate ideal swap
  const amountIn = tokenReserve / 1000n;
  const idealOut = (amountIn * wbnbReserve * 9975n) / (tokenReserve * 10000n + amountIn * 9975n);

  // Include 1-2% slippage + gas buffer
  const maxAllowed = Number(idealOut * 110n / 100n); // +10% buffer
  return { ok:true, fee:maxAllowed };
}

/* ================= FORK SELL SIMULATION ================= */
export async function forkSellSimulation(token) {
  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const wallet = ethers.Wallet.createRandom().connect(provider);

  // Fund wallet
  await provider.send("hardhat_setBalance", [wallet.address, "0x1000000000000000000"]);

  const router = new ethers.Contract(
    ROUTER,
    [
      "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint,address[],address,uint) payable",
      "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint,uint,address[],address,uint)"
    ],
    wallet
  );

  const tokenC = new ethers.Contract(token, ["function approve(address,uint256)", "function balanceOf(address) view returns(uint256)"], wallet);
  const deadline = Math.floor(Date.now() / 1000) + 60;

  // 1️⃣ BUY
  try {
    await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0, [WBNB, token], wallet.address, deadline, { value: ethers.parseEther("0.01") }
    );
  } catch {
    return { ok:false, honeypot:true, reason:"BUY_FAILED" };
  }

  const tokenBalance = await tokenC.balanceOf(wallet.address);
  if (tokenBalance === 0n) return { ok:false, honeypot:true, reason:"NO_TOKENS_RECEIVED" };

  await tokenC.approve(ROUTER, tokenBalance);

  // 2️⃣ SELL
  const bnbBefore = await provider.getBalance(wallet.address);
  try {
    await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenBalance, 0, [token, WBNB], wallet.address, deadline
    );
  } catch {
    return { ok:false, honeypot:true, reason:"SELL_REVERT" };
  }
  const bnbAfter = await provider.getBalance(wallet.address);

  // 3️⃣ Calculate sell tax %
  const actualOut = bnbAfter - bnbBefore;
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(token, WBNB);
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();
  const tokenReserve = token0 === token.toLowerCase() ? BigInt(reserves[0]) : BigInt(reserves[1]);
  const wbnbReserve = token0 === token.toLowerCase() ? BigInt(reserves[1]) : BigInt(reserves[0]);
  const expectedOut = (tokenBalance * wbnbReserve * 9975n) / (tokenReserve * 10000n + tokenBalance * 9975n);
  const sellTaxPercent = Number((expectedOut - actualOut) * 100n / expectedOut);

  if (sellTaxPercent === 0) return { ok:true, honeypot:false, reason:"ZERO_TAX" };
  else if (sellTaxPercent > 90) return { ok:false, honeypot:true, reason:"HIGH_SELL_TAX" };
  else return { ok:false, honeypot:true, reason:`SELL_TAX_${sellTaxPercent}%` };
}

/* ================= WALLET RATE ================= */
export async function walletRate(token: string) {
  if (!validateToken(token)) return {
    token,
    totalScore: 0,
    health: "unhealthy",
    details: { reason: "Invalid token" }
  };

  const result = {
    token,
    totalScore: 0,
    health: "unhealthy",
    details: {
      lpOwnership: { score: 0, status: "unhealthy" },
      sellSimulation: { score: 0, status: "unhealthy" },
      swapFee: { score: 0, status: "unhealthy" },
      devWallet: { score: 0, status: "unhealthy" }
    }
  };

  // 1️⃣ LP Ownership + Delayed Rug (max 125)
  const lp = await checkLpOwner(token);
  if (lp.lpExists) {
    result.details.lpOwnership = {
      score: lp.totalScore > 125 ? 125 : lp.totalScore, // cap at 125
      status: lp.totalScore >= 100 ? "healthy" : "unhealthy",
      metrics: lp.metrics,
      rug: lp.rug
    };
    result.totalScore += result.details.lpOwnership.score;
  }

  // 2️⃣ Sell Simulation (20 points)
  const sell = await forkSellSimulation(token);
  if (sell.ok) {
    result.details.sellSimulation = { score: 20, status: "healthy", honeypot: sell.honeypot };
    result.totalScore += 20;
  } else {
    result.details.sellSimulation = { score: 0, status: "unhealthy", reason: sell.reason };
  }

  // 3️⃣ Swap Fee (15 points)
  const fee = await swapFeeCheck(token);
  if (fee.ok && fee.fee <= 10) {
    result.details.swapFee = { score: 15, status: "healthy", fee: fee.fee };
    result.totalScore += 15;
  }

  // 4️⃣ Dev Wallet (15 points)
  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) {
    result.details.devWallet = { score: 15, status: "healthy" };
    result.totalScore += 15;
  }

  // ✅ Health based on total score threshold (150)
  result.health = result.totalScore >= 150 ? "healthy" : "unhealthy";

  return result;
}