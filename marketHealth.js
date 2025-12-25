import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_30,
  process.env.RPC_URL_40,
  process.env.RPC_URL_50
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs provided");

let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

const queue = new PQueue({ concurrency: 1, interval: 3000, intervalCap: 4 });

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
  console.warn(`RPC switched to ${RPC_URLS[rpcIndex]}`);
}

async function callProvider(fn, retries = RPC_URLS.length) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const p = provider;
    try { return await fn(p); }
    catch (e) { lastErr = e; rotateRpc(); }
  }
  throw lastErr;
}

/* ================= CONSTANTS ================= */
const WBNB = ethers.getAddress(process.env.WBNB_ADDRESS.toLowerCase());
const ZERO = ethers.ZeroAddress.toLowerCase();
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

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
    const code = await queue.add(() => callProvider(p => p.getCode(addr)));
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
      } catch { rotateRpc(); }
    }
  }
  return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/* ================= MARKET HEALTH ================= */
export async function marketHealthPass(pairAddress) {
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      const pair = ethers.getAddress(pairAddress).toLowerCase();
      const token = await resolveTokenFromPair(pair);

      const latest = await queue.add(() => callProvider(p => p.getBlockNumber()));
      const fromBlock = Math.max(0, latest - EARLY_SCAN_BLOCKS);

      const logs = await fetchLogsInBatches(token, TRANSFER_TOPIC, fromBlock, latest);
      if (!logs.length) return { isHealthy: false, realVolume: 0n, pumpPotential: 0 };

      const buyers = new Map();
      const sellers = new Map();
      const buyBlocks = new Set();
      let sold = 0n;

      for (const l of logs.slice(0, EARLY_SCAN_LIMIT)) {
        const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
        const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const amt = BigInt(l.data);

        if ([ZERO, DEAD].includes(from) || [ZERO, DEAD].includes(to)) continue;

        if (from === pair) { buyers.set(to, (buyers.get(to) || 0n) + amt); buyBlocks.add(l.blockNumber); }
        if (to === pair) { sellers.set(from, (sellers.get(from) || 0n) + amt); sold += amt; }
      }

      // Check EOAs
      const allAddrs = [...new Set([...buyers.keys(), ...sellers.keys()])];
      await batchIsEOA(allAddrs);

      const realBuyers = [...buyers.keys()].filter(a => eoaCache.get(a));
      const realSellers = [...sellers.keys()].filter(a => eoaCache.get(a));

      const totalBought = [...buyers.values()].reduce((a, b) => a + b, 0n);
      const maxBuy = [...buyers.values()].reduce((a, b) => (b > a ? b : a), 0n);

      const supply = BigInt(await queue.add(() => callProvider(p => new ethers.Contract(token, ERC20_ABI, p).totalSupply())));
      const soldPct = supply > 0n ? (sold * 100n) / supply : 100n;
      const maxBuyPct = totalBought > 0n ? (maxBuy * 100n) / totalBought : 100n;

      // ================= PUMP POTENTIAL CALCULATION =================
      let score = 0;
      score += Math.min(30, realBuyers.length * 3); // buyer count
      score += soldPct <= MAX_EARLY_SELL_PCT ? 30 : Math.max(0, 30 - Number(soldPct));
      score += maxBuyPct <= MAX_SINGLE_BUY_SHARE ? 20 : Math.max(0, 20 - Number(maxBuyPct));
      score += Math.min(20, buyBlocks.size * 4); // spread factor
      if (score > 100) score = 100;

      const isHealthy = realBuyers.length >= MIN_BUYERS_EOA &&
                        realSellers.length >= MIN_SELLERS_EOA &&
                        maxBuyPct <= MAX_SINGLE_BUY_SHARE &&
                        soldPct <= MAX_EARLY_SELL_PCT &&
                        buyBlocks.size >= Math.min(5, realBuyers.length);

      return {
        isHealthy,
        pumpPotential: score,
        realVolume: totalBought,
        maxBuyPct,
        soldPct,
        buyBlocks: buyBlocks.size
      };
    } catch (e) {
      console.warn("RPC error:", e?.message || e);
      rotateRpc();
    }
  }

  return { isHealthy: false, pumpPotential: 0, realVolume: 0n };
}