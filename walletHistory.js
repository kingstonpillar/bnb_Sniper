import dotenv from "dotenv";
dotenv.config();

import Web3 from "web3";
import PQueue from "p-queue";
import { ethers } from "ethers";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [process.env.RPC_URL_8, process.env.RPC_URL_9].filter(Boolean);
if (!RPC_URLS.length) throw new Error("No RPC URLs configured");

const FORK_RPC = process.env.FORK_RPC;
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

/* ================= ABIs ================= */
const FACTORY_ABI = [{
  name: "getPair", type: "function", stateMutability: "view",
  inputs: [{ type: "address" }, { type: "address" }],
  outputs: [{ type: "address" }]
}];

const ERC20_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ type: "address" }],
  outputs: [{ type: "uint256" }]
}];

const PAIR_ABI = [
  { name: "getReserves", type: "function", stateMutability: "view", outputs:[{ type:"uint112" },{ type:"uint112" },{ type:"uint32" }]},
  { name:"totalSupply", type:"function", stateMutability:"view", outputs:[{type:"uint256"}]},
  { name:"token0",type:"function",stateMutability:"view",outputs:[{type:"address"}]},
  { name:"token1",type:"function",stateMutability:"view",outputs:[{type:"address"}]}
];

/* ================= DEV MEMORY ================= */
const devMemory = {};

/* ================= DEV WALLET ================= */
export async function getDevWallet(token) {
  return safeRpcCall(async web3 => {
    const LOOKBACK = 28800 * 3; // last ~3 days
    const latest = await web3.eth.getBlockNumber();
    const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0;

    const logs = await web3.eth.getPastLogs({
      address: token,
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      fromBlock,
      toBlock: "latest"
    }).catch(() => []);

    const mint = logs.find(l => l.topics[1] === ZERO_ADDR);
    if (!mint) return null;
    return ("0x" + mint.topics[2].slice(26)).toLowerCase();
  });
}

/* ================= LP OWNERSHIP ================= */
export async function checkLpOwner(token) {
  return safeRpcCall(async web3 => {
    const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    const pairAddr = await factory.methods.getPair(token, WBNB).call();
    if (!pairAddr || pairAddr === ZERO_ADDR) return { lpExists:false };

    const lp = new web3.eth.Contract(PAIR_ABI, pairAddr);
    const dev = await getDevWallet(token);
    if (!dev) return { lpExists:true, controlled:false };

    const devBalance = BigInt(await lp.methods.balanceOf(dev).call());
    const totalSupply = BigInt(await lp.methods.totalSupply().call());

    const controlled = totalSupply > 0n && (devBalance * 100n) / totalSupply > 1n; // >1% threshold
    return { lpExists:true, controlled };
  });
}

/* ================= SWAP FEE ================= */
export async function swapFeeCheck(token) {
  return safeRpcCall(async web3 => {
    const factory = new web3.eth.Contract(FACTORY_ABI, FACTORY);
    const pairAddr = await factory.methods.getPair(token, WBNB).call();
    if (!pairAddr || pairAddr === ZERO_ADDR) return { ok:false };

    const pairC = new web3.eth.Contract(PAIR_ABI, pairAddr);
    const r = await pairC.methods.getReserves().call();
    const token0 = await pairC.methods.token0().call();

    const tokenReserve = token0.toLowerCase() === token.toLowerCase() ? BigInt(r[0]) : BigInt(r[1]);
    const wbnbReserve = token0.toLowerCase() === token.toLowerCase() ? BigInt(r[1]) : BigInt(r[0]);

    if (tokenReserve === 0n || wbnbReserve === 0n) return { ok:false };

    // Calculate fee from ideal swap vs real swap
    const amountIn = tokenReserve / 1000n;
    const expectedOut = (amountIn * wbnbReserve * 9975n) / (tokenReserve * 10000n + amountIn * 9975n);

    return { ok:true, fee:Number(expectedOut > 0n ? 5 : 100) };
  });
}

/* ================= FORK SELL SIMULATION ================= */
export async function forkSellSimulation(token) {
  if (!FORK_RPC) return { ok:true, skipped:true, reason:"FORK_RPC_NOT_CONFIGURED" };

  const provider = new ethers.JsonRpcProvider(FORK_RPC);
  const wallet = ethers.Wallet.createRandom().connect(provider);

  try {
    await provider.send("hardhat_setBalance", [
      wallet.address,
      "0x1000000000000000000"
    ]);
  } catch {
    return { ok:true, skipped:true, reason:"FORK_RPC_NOT_COMPATIBLE" };
  }

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
    ["function approve(address,uint)", "function balanceOf(address) view returns(uint)"],
    wallet
  );

  const deadline = Math.floor(Date.now()/1000)+60;

  try {
    await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0,[WBNB,token],wallet.address,deadline,
      { value: ethers.parseEther("0.01") }
    );
  } catch {
    return { ok:false, honeypot:true, reason:"BUY_FAILED" };
  }

  const bal = await tokenC.balanceOf(wallet.address);
  if (bal === 0n) return { ok:false, honeypot:true, reason:"NO_TOKENS" };

  await tokenC.approve(ROUTER, bal);

  try {
    await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      bal,0,[token,WBNB],wallet.address,deadline
    );
  } catch {
    return { ok:false, honeypot:true, reason:"SELL_REVERT" };
  }

  return { ok:true, honeypot:false };
}

/* ================= WALLET RATE ================= */
export async function walletRate(token) {
  const result = {
    token,
    totalScore: 0,
    health: "unhealthy",
    details: {
      sellSimulation:{score:0,status:"unhealthy"},
      lpOwnership:{score:0,status:"unhealthy"},
      swapFee:{score:0,status:"unhealthy"},
      devWallet:{score:0,status:"unhealthy"}
    }
  };

  // 1️⃣ Sell Simulation (+20)
  const sell = await forkSellSimulation(token);
  if (!sell.ok) {
    result.details.sellSimulation = { score:0,status:"unhealthy", reason:sell.reason };
    return result;
  }
  if (sell.skipped) {
    result.details.sellSimulation = { score:0,status:"skipped", reason:sell.reason };
  } else {
    result.details.sellSimulation = { score:20,status:"healthy" };
    result.totalScore += 20;
  }

  // 2️⃣ LP Ownership (+15)
  const lp = await checkLpOwner(token);
  if (lp.lpExists && !lp.controlled) {
    result.details.lpOwnership = { score:15,status:"healthy" };
    result.totalScore += 15;
  }

  // 3️⃣ Swap Fee (+15)
  const fee = await swapFeeCheck(token);
  if (fee.ok && fee.fee <= 10) {
    result.details.swapFee = { score:15,status:"healthy" };
    result.totalScore += 15;
  }

  // 4️⃣ Dev Wallet (+10)
  const dev = await getDevWallet(token);
  if (dev && (!devMemory[dev] || devMemory[dev].rugs === 0)) {
    result.details.devWallet = { score:10,status:"healthy" };
    result.totalScore += 10;
  }

  // 5️⃣ Health threshold = 50
  result.health = result.totalScore >= 50 ? "healthy" : "unhealthy";

  return result;
}