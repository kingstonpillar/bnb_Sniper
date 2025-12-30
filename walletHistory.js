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
  const deployer = await getDevWallet(token);
  const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
  const pairAddr = await factory.methods.getPair(token, WBNB).call();
  if (!pairAddr || pairAddr === ZERO_ADDR) return { lpExists: false, totalScore: 0n, metrics: { lpBurnedPercent: 0n, devLpPercent: 0n, lockedPercent: 0n }, rug: null };

  const lp = new web3.eth.Contract(PAIR_ABI, pairAddr);
  const totalSupply = BigInt(await lp.methods.totalSupply().call() || "0");
  if (totalSupply === 0n) return { lpExists: false, totalScore: 0n, metrics: { lpBurnedPercent: 0n, devLpPercent: 0n, lockedPercent: 0n }, rug: null };

  const burnBalance = BigInt(await lp.methods.balanceOf(ZERO_ADDR).call() || "0") + BigInt(await lp.methods.balanceOf("0x000000000000000000000000000000000000dEaD").call() || "0");
  const devBalance = deployer ? BigInt(await lp.methods.balanceOf(deployer).call() || "0") : 0n;

  let lockedAmount = 0n, lockOwner, lockExpiry, splitLock = false;
  for (const lockerDef of LOCKER_ABIS) {
    try {
      const locker = new web3.eth.Contract(lockerDef.abi, lockerDef.address);
      const lockRaw = await locker.methods.getLockInfo(pairAddr).call();
      if (lockRaw && BigInt(lockRaw.amount || "0") > 0n) {
        if (!lockOwner) { lockOwner = lockRaw.owner?.toLowerCase(); lockExpiry = BigInt(lockRaw.expiry || "0"); lockedAmount += BigInt(lockRaw.amount || "0"); }
        else { splitLock = true; lockedAmount += BigInt(lockRaw.amount || "0"); }
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

  const rug = await delayedRugCheck(token, FORK_RPC);
  const rugScore = rug?.verdict === "DELAYED_RUG_LIKELY" ? 0n : 25n;

  return { lpExists: true, metrics: { lpBurnedPercent, devLpPercent, lockedPercent, lockExpiry, lockOwner, splitLock }, rug, totalScore: lpScore + rugScore };
}

/* ===========================================================
   🔹 FORK SELL SIMULATION (BIGINT-SAFE)
=========================================================== */
export async function forkSellSimulation(token) {
  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const wallet = ethers.Wallet.createRandom().connect(provider);
  await provider.send("hardhat_setBalance", [wallet.address, "0x1000000000000000000"]);

  const router = new ethers.Contract(ROUTER, [
    "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint,address[],address,uint) payable",
    "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint,uint,address[],address,uint)"
  ], wallet);

  const tokenC = new ethers.Contract(token, ["function approve(address,uint256)", "function balanceOf(address) view returns(uint256)"], wallet);

  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 60n;
  const ethIn = ethers.parseEther("0.01");

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(token, WBNB);
  if (!pairAddress || pairAddress === ZERO_ADDR) return { ok:false, honeypot:true, reason:"NO_PAIR" };

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();
  const tokenReserve = token0 === token.toLowerCase() ? BigInt(reserves[0]) : BigInt(reserves[1]);
  const wbnbReserve = token0 === token.toLowerCase() ? BigInt(reserves[1]) : BigInt(reserves[0]);
  if (tokenReserve === 0n || wbnbReserve === 0n) return { ok:false, honeypot:true, reason:"EMPTY_LP" };

  try { await router.swapExactETHForTokensSupportingFeeOnTransferTokens(0n, [WBNB, token], wallet.address, deadline, { value: ethIn }); }
  catch { return { ok:false, honeypot:true, reason:"BUY_FAILED" }; }

  const tokenBalance = BigInt(await tokenC.balanceOf(wallet.address));
  if (tokenBalance === 0n) return { ok:false, honeypot:true, reason:"NO_TOKENS_RECEIVED" };

  const expectedBuyOut = (ethIn * tokenReserve * 9975n) / (wbnbReserve * 10000n + ethIn * 9975n);
  let buyTaxPercent = expectedBuyOut > tokenBalance ? ((expectedBuyOut - tokenBalance) * 100n) / expectedBuyOut : 0n;
  if (buyTaxPercent > 10n) return { ok:false, honeypot:true, reason:`HIGH_BUY_TAX_${buyTaxPercent}%` };

  await tokenC.approve(ROUTER, tokenBalance);

  const bnbBefore = BigInt(await provider.getBalance(wallet.address));
  try { await router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokenBalance, 0n, [token, WBNB], wallet.address, deadline); }
  catch { return { ok:false, honeypot:true, reason:"SELL_REVERT" }; }

  const bnbAfter = BigInt(await provider.getBalance(wallet.address));
  const actualOut = bnbAfter - bnbBefore;
  const expectedOut = (tokenBalance * wbnbReserve * 9975n) / (tokenReserve * 10000n + tokenBalance * 9975n);
  let sellTaxPercent = expectedOut > actualOut ? ((expectedOut - actualOut) * 100n) / expectedOut : 0n;

  if (sellTaxPercent === 0n) return { ok:true, honeypot:false, reason:"ZERO_TAX" };
  if (sellTaxPercent > 90n) return { ok:false, honeypot:true, reason:"HIGH_SELL_TAX" };
  return { ok:false, honeypot:true, reason:`SELL_TAX_${sellTaxPercent}%` };
}

/* ===========================================================
   🔹 SWAP FEE CHECK (BIGINT-SAFE)
=========================================================== */
export async function swapFeeCheck(token) {
  const provider = new Web3(FORK_RPC);
  const factory = new provider.eth.Contract(FACTORY_ABI, FACTORY);

  const pairAddress = await factory.methods.getPair(token, WBNB).call();
  if (!pairAddress || pairAddress === ZERO_ADDR) return { ok:false, priceImpactPercent: 0n };

  const pair = new provider.eth.Contract(PAIR_ABI, pairAddress);
  const reservesRaw = await pair.methods.getReserves().call();
  const token0 = (await pair.methods.token0().call()).toLowerCase();
  const tokenReserve = token0 === token.toLowerCase() ? BigInt(reservesRaw[0] || "0") : BigInt(reservesRaw[1] || "0");
  if (tokenReserve === 0n) return { ok:false, priceImpactPercent: 0n };

  const amountIn = tokenReserve / 1000n;
  if (amountIn === 0n) return { ok:false, priceImpactPercent: 0n };

  const priceImpactPercent = (amountIn * 100n) / (tokenReserve + amountIn);
  return { ok:true, priceImpactPercent };
}

/* ===========================================================
   🔹 WALLET RATE (BIGINT-SAFE)
=========================================================== */
export async function walletRate(token) {
  if (!validateToken(token)) return { token, totalScore: 0n, health:"unhealthy", details:{ reason:"Invalid token" } };

  const result = {
    token, totalScore: 0n, health: "unhealthy",
    details: {
      lpOwnership: { score: 0n, status:"unhealthy" },
      sellSimulation: { score: 0n, status:"unhealthy" },
      swapFee: { score: 0n, status:"unhealthy" },
      devWallet: { score: 0n, status:"unhealthy" }
    }
  };

  const lp = await checkLpOwner(token);
  if (lp.lpExists) {
    const lpScore = lp.totalScore > 125n ? 125n : lp.totalScore;
    const lpStatus = lpScore >= 100n ? "healthy" : "unhealthy";
    result.details.lpOwnership = { score: lpScore, status: lpStatus, metrics: lp.metrics, rug: lp.rug };
    result.totalScore += lpScore;
  }

  const sell = await forkSellSimulation(token);
  if (sell.ok) { result.details.sellSimulation = { score: 20n, status:"healthy", honeypot:!!sell.honeypot }; result.totalScore += 20n; }
  else { result.details.sellSimulation = { score:0n, status:"unhealthy", reason:sell.reason }; }

  const fee = await swapFeeCheck(token);
  const feePercentBI = BigInt(fee?.priceImpactPercent || 0n);
  if (fee.ok && feePercentBI <= 10n) { result.details.swapFee = { score:15n, status:"healthy", feePercent: feePercentBI }; result.totalScore += 15n; }

  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) { result.details.devWallet = { score:15n, status:"healthy" }; result.totalScore += 15n; }

  result.health = result.totalScore >= 130n ? "healthy" : "unhealthy";
  return result;
}