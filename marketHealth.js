import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs provided");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

const queue = new PQueue({
  concurrency: 1,
  interval: 3000,
  intervalCap: 4
});

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
  console.warn(`➡️ RPC switched → ${RPC_URLS[rpcIndex]}`);
}

async function callProvider(fn, retries = RPC_URLS.length) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const p = provider;
    try {
      return await fn(p);
    } catch (e) {
      lastErr = e;
      rotateRpc();
    }
  }
  throw lastErr;
}

/* ================= CONSTANTS ================= */
const WBNB = ethers.getAddress(process.env.WBNB_ADDRESS.toLowerCase());
const PANCAKE_ROUTER = ethers.getAddress(process.env.PANCAKE_ROUTER);
const ZERO = ethers.ZeroAddress.toLowerCase();
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

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

/* ================= SETTINGS ================= */
const EARLY_SCAN_LIMIT = 200;
const EARLY_SCAN_BLOCKS = 600;
const MIN_BUYERS_EOA = 13;
const MIN_SELLERS_EOA = 4;
const MAX_SINGLE_BUY_SHARE = 60n;
const MAX_EARLY_SELL_PCT = 2n;
const MAX_LOG_RETRIES = 3;

/* ================= HELPERS ================= */
const eoaCache = new Map();

async function isEOA(addr) {
  if (eoaCache.has(addr)) return eoaCache.get(addr);
  try {
    const code = await queue.add(() =>
      callProvider(p => p.getCode(addr))
    );
    const res = code === "0x";
    eoaCache.set(addr, res);
    return res;
  } catch {
    return false;
  }
}

async function batchIsEOA(addrs) {
  for (const a of addrs) await isEOA(a);
}

async function resolveTokenFromPair(pair) {
  const lp = new ethers.Contract(pair, PAIR_ABI, provider);
  const [t0, t1] = await Promise.all([
    queue.add(() => callProvider(p => lp.connect(p).token0())),
    queue.add(() => callProvider(p => lp.connect(p).token1()))
  ]);
  if (t0 === WBNB) return t1;
  if (t1 === WBNB) return t0;
  throw new Error("Pair does not include WBNB");
}

async function fetchLogsInBatches(address, topic, fromBlock, toBlock, batchSize = 500) {
  const logs = [];

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);

    for (let r = 0; r < MAX_LOG_RETRIES; r++) {
      try {
        const batch = await queue.add(() =>
          callProvider(p =>
            p.getLogs({ address, topics: [topic], fromBlock: start, toBlock: end })
          )
        );
        logs.push(...batch);
        break;
      } catch {
        rotateRpc();
      }
    }
  }

  return logs.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
  );
}

/* ================= HOLDER CHECK ================= */
async function topHolderCheck(token, pair, logs, supply, maxPct = 15n) {
  const balances = new Map();

  for (const l of logs) {
    const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
    const val = BigInt(l.data);

    if (![ZERO, DEAD].includes(from))
      balances.set(from, (balances.get(from) || 0n) - val);

    if (![ZERO, DEAD].includes(to))
      balances.set(to, (balances.get(to) || 0n) + val);
  }

  balances.delete(pair.toLowerCase());

  const top10 = [...balances.values()]
    .filter(v => v > 0n)
    .sort((a, b) => (b > a ? 1 : -1))
    .slice(0, 10)
    .reduce((a, b) => a + b, 0n);

  const pct = supply > 0n ? (top10 * 100n) / supply : 100n;
  console.log(`🧠 Top10 holders: ${pct}%`);
  return pct <= maxPct;
}

/* ================= MARKET HEALTH ================= */
export async function marketHealthPass(pairAddress) {
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      const pair = ethers.getAddress(pairAddress).toLowerCase();
      const token = await resolveTokenFromPair(pair);

      const latest = await queue.add(() =>
        callProvider(p => p.getBlockNumber())
      );

      const fromBlock = Math.max(0, latest - EARLY_SCAN_BLOCKS);
      const logs = await fetchLogsInBatches(token, TRANSFER_TOPIC, fromBlock, latest);
      if (!logs.length) return false;

      const buyers = new Map();
      const sellers = new Map();
      const buyBlocks = new Set();
      let sold = 0n;

      for (const l of logs.slice(0, EARLY_SCAN_LIMIT)) {
        const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
        const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const amt = BigInt(l.data);

        if ([ZERO, DEAD].includes(from) || [ZERO, DEAD].includes(to)) continue;

        if (from === pair) {
          buyers.set(to, (buyers.get(to) || 0n) + amt);
          buyBlocks.add(l.blockNumber);
        }

        if (to === pair) {
          sellers.set(from, (sellers.get(from) || 0n) + amt);
          sold += amt;
        }
      }

      const allAddrs = [...new Set([...buyers.keys(), ...sellers.keys()])];
      await batchIsEOA(allAddrs);

      const realBuyers = [...buyers.keys()].filter(a => eoaCache.get(a));
      const realSellers = [...sellers.keys()].filter(a => eoaCache.get(a));

      const totalBought = [...buyers.values()].reduce((a, b) => a + b, 0n);
      const maxBuy = [...buyers.values()].reduce((a, b) => (b > a ? b : a), 0n);

      const supply = BigInt(
        await queue.add(() =>
          callProvider(p =>
            new ethers.Contract(token, ERC20_ABI, p).totalSupply()
          )
        )
      );

      const soldPct = supply > 0n ? (sold * 100n) / supply : 100n;
      const maxBuyPct = totalBought > 0n ? (maxBuy * 100n) / totalBought : 100n;

      // ===== DEBUG LOG =====
      console.log({
        realBuyers: realBuyers.length,
        realSellers: realSellers.length,
        soldPct: soldPct.toString(),
        maxBuyPct: maxBuyPct.toString(),
        buyBlocks: buyBlocks.size
      });

      if (realBuyers.length < MIN_BUYERS_EOA) return false;
      if (realSellers.length < MIN_SELLERS_EOA) return false;
      if (maxBuyPct > MAX_SINGLE_BUY_SHARE) return false;
      if (soldPct > MAX_EARLY_SELL_PCT) return false;
      if (buyBlocks.size < Math.min(5, realBuyers.length)) return false;

      return await topHolderCheck(token, pair, logs, supply);
    } catch (e) {
      console.warn("RPC error:", e?.message || e);
      rotateRpc();
    }
  }

  return false;
}



/* ============================================================
    SWAP FEE CHECK FUNCTION
   Checks the effective swap fee for a token pair on PancakeSwap
   and ensures it is below the configured threshold.
============================================================ */
export async function swapFeeCheck(pairAddress, maxFeePct = 10) {
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);

      const [t0, t1, reserves] = await Promise.all([
        queue.add(() => callProvider(p => pair.connect(p).token0())),
        queue.add(() => callProvider(p => pair.connect(p).token1())),
        queue.add(() => callProvider(p => pair.connect(p).getReserves())),
      ]);

      const WBNB = ethers.getAddress(process.env.WBNB_ADDRESS);

      let reserveIn, reserveOut, token;

      const [r0, r1] = Array.isArray(reserves)
        ? reserves
        : [reserves._reserve0, reserves._reserve1];

      if (t0.toLowerCase() === WBNB.toLowerCase()) {
        reserveIn = BigInt(r0);
        reserveOut = BigInt(r1);
        token = t1;
      } else if (t1.toLowerCase() === WBNB.toLowerCase()) {
        reserveIn = BigInt(r1);
        reserveOut = BigInt(r0);
        token = t0;
      } else {
        console.warn(` Pair ${pairAddress} does not contain WBNB`);
        return false;
      }

      const amountIn = ethers.parseEther("0.01");
      const amountInWithFee = amountIn * 997n;
      const expectedOut =
        (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);

      const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, provider);
      const actualOut = BigInt(
        await queue.add(() =>
          callProvider(p =>
            router.connect(p)
              .getAmountsOut(amountIn, [WBNB, token])
              .then(r => BigInt(r[1].toString()))
          )
        )
      );

      const feePct =
        expectedOut > actualOut
          ? Number((expectedOut - actualOut) * 10000n / expectedOut) / 100
          : 0;

      console.log(` Swap fee for ${pairAddress}: ${feePct.toFixed(2)}%`);
      console.log(` ExpectedOut: ${expectedOut}, ActualOut: ${actualOut}`);

      return feePct <= maxFeePct;
    } catch (err) {
      console.warn(` swapFeeCheck failed on RPC ${RPC_URLS[i]}:`, err.message);
      rotateRpc();
    }
  }

  console.error(` swapFeeCheck failed on all RPCs for ${pairAddress}`);
  return false;
}