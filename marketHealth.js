import dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= RPC ================= */
const RPC_URLS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

const queue = new PQueue({ interval: 3000, intervalCap: 4, concurrency: 1 });

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
  console.log(`➡️ RPC switched → ${RPC_URLS[rpcIndex]}`);
}

async function withRpcFailover(fn) {
  let last;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await queue.add(() => fn(provider));
    } catch (e) {
      last = e;
      rotateRpc();
    }
  }
  throw last;
}

/* ================= CONSTANTS ================= */
const WBNB = ethers.getAddress("0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const ZERO = ethers.ZeroAddress;
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const PANCAKE_ROUTER =
  process.env.PANCAKE_ROUTER ||
  "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];

const ERC20_ABI = [
  "function totalSupply() view returns(uint256)",
  "event Transfer(address indexed from,address indexed to,uint256)"
];

/* ================= HELPERS ================= */
const eoaCache = new Map();

async function isEOA(addr, prov) {
  if (eoaCache.has(addr)) return eoaCache.get(addr);
  const is = (await prov.getCode(addr)) === "0x";
  eoaCache.set(addr, is);
  return is;
}

/* ================= TOKEN RESOLUTION ================= */
async function resolveTokenFromPair(pair, prov) {
  const lp = new ethers.Contract(pair, PAIR_ABI, prov);
  const [t0, t1] = await Promise.all([lp.token0(), lp.token1()]);
  if (t0 === WBNB) return t1;
  if (t1 === WBNB) return t0;
  throw new Error("Pair does not contain WBNB");
}

/* ================= TOP HOLDER CHECK ================= */
async function topHolderCheck(token, pair, maxPct = 0.13, scanBlocks = 20_000) {
  return withRpcFailover(async (prov) => {
    const erc = new ethers.Contract(token, ERC20_ABI, prov);
    const supply = BigInt(await erc.totalSupply());

    const latest = await prov.getBlockNumber();
    const fromBlock = Math.max(0, latest - scanBlocks);

    const logs = await prov.getLogs({
      address: token,
      topics: [TRANSFER_TOPIC],
      fromBlock,
      toBlock: latest
    });

    if (!logs.length) return false;

    const balances = new Map();

    for (const l of logs) {
      const from = "0x" + l.topics[1].slice(26).toLowerCase();
      const to   = "0x" + l.topics[2].slice(26).toLowerCase();
      const val  = BigInt(l.data);

      if (![ZERO, DEAD].includes(from)) balances.set(from, (balances.get(from) || 0n) - val);
      if (![ZERO, DEAD].includes(to)) balances.set(to, (balances.get(to) || 0n) + val);
    }

    balances.delete(pair.toLowerCase());

    const topSum = [...balances.entries()]
      .filter(([, b]) => b > 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 10)
      .reduce((a, [, b]) => a + b, 0n);

    const pct = Number(topSum) / Number(supply);

    console.log(`🧠 Top10 holders: ${(pct * 100).toFixed(2)}%`);
    return pct <= maxPct;
  });
}

/* ================= MARKET HEALTH ================= */
export async function marketHealthPass(pairAddress) {
  return withRpcFailover(async (prov) => {
    const pair = ethers.getAddress(pairAddress);
    const token = await resolveTokenFromPair(pair, prov);

    const latest = await prov.getBlockNumber();
    const fromBlock = latest - 5000;

    const logs = await prov.getLogs({
      address: token,
      topics: [TRANSFER_TOPIC],
      fromBlock,
      toBlock: latest
    });

    const buyers = new Set();
    const sellers = new Set();
    const buyBlocks = new Set();
    let sold = 0n;

    for (const l of logs) {
      const from = "0x" + l.topics[1].slice(26);
      const to   = "0x" + l.topics[2].slice(26);
      const amt  = BigInt(l.data);

      if (from.toLowerCase() === pair.toLowerCase() && await isEOA(to, prov)) {
        buyers.add(to.toLowerCase());
        buyBlocks.add(l.blockNumber);
      }

      if (to.toLowerCase() === pair.toLowerCase() && await isEOA(from, prov)) {
        sellers.add(from.toLowerCase());
        sold += amt;
      }
    }

    const supply = BigInt(await new ethers.Contract(token, ERC20_ABI, prov).totalSupply());
    const soldPct = Number(sold) / Number(supply);

    const topOk = await topHolderCheck(token, pair);

    const pass =
      buyers.size >= 20 &&
      sellers.size >= 5 &&
      buyBlocks.size >= 20 &&
      soldPct <= 0.05 &&
      topOk;

    console.log("📊 Market health", {
      pair,
      token,
      buyers: buyers.size,
      sellers: sellers.size,
      buyBlocks: buyBlocks.size,
      soldPct: (soldPct * 100).toFixed(2),
      topOk,
      pass
    });

    return pass;
  });
}

/* ================= SWAP FEE CHECK ================= */
export async function swapFeeCheck(pairAddress, maxFeePct = 0.10) {
  return withRpcFailover(async (prov) => {
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    const [t0, t1, reserves] = await Promise.all([
      pair.token0(),
      pair.token1(),
      pair.getReserves()
    ]);

    let token, reserveIn, reserveOut;

    if (t0 === WBNB) {
      token = t1;
      reserveIn = reserves[0];
      reserveOut = reserves[1];
    } else if (t1 === WBNB) {
      token = t0;
      reserveIn = reserves[1];
      reserveOut = reserves[0];
    } else {
      throw new Error("Pair does not include WBNB");
    }

    const amountIn = ethers.parseEther("0.01");

    const amountInWithFee = amountIn * 997n;
    const expectedOut =
      (amountInWithFee * reserveOut) /
      (reserveIn * 1000n + amountInWithFee);

    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, prov);
    const actualOut = (await router.getAmountsOut(amountIn, [WBNB, token]))[1];

    const feePct = 1 - Number(actualOut) / Number(expectedOut);

    console.log(`🔍 Swap fee: ${(feePct * 100).toFixed(2)}%`);
    return feePct <= maxFeePct;
  });
}