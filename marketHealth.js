// file: marketHealth.js
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

const queue = new PQueue({
  concurrency: 1,
  interval: 3000,
  intervalCap: 4
});

function rotateRpc() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
  console.warn(`RPC switched to ${RPC_URLS[rpcIndex]}`);
}

async function callProvider(fn, retries = RPC_URLS.length) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const p = provider;
    try {
      return await queue.add(() => fn(p));
    } catch (e) {
      lastErr = e;
      rotateRpc();
    }
  }
  throw lastErr;
}

/* ================= CONSTANTS ================= */
function reqEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function asAddressLower(v, k) {
  try {
    return ethers.getAddress(String(v || "")).toLowerCase();
  } catch (e) {
    throw new Error(`Invalid address for ${k}: ${String(v || "")}`);
  }
}

const WBNB = asAddressLower(reqEnv("WBNB_ADDRESS"), "WBNB_ADDRESS");
const PANCAKE_ROUTER = asAddressLower(reqEnv("PANCAKE_ROUTER"), "PANCAKE_ROUTER");

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

/* ================= SETTINGS (Option A Defaults) ================= */
const EARLY_SCAN_LIMIT = Number(process.env.EARLY_SCAN_LIMIT || 200);
const EARLY_SCAN_BLOCKS = Number(process.env.EARLY_SCAN_BLOCKS || 800);

// Reduced strictness for short observation windows
const MIN_BUYERS_EOA = Number(process.env.MIN_BUYERS_EOA || 3);
const MIN_SELLERS_EOA = Number(process.env.MIN_SELLERS_EOA || 2);

// Activity gates not dependent on EOA only
const MIN_BUY_TXS = Number(process.env.MIN_BUY_TXS || 6);
const MIN_UNIQUE_RECIPIENTS_ALL = Number(process.env.MIN_UNIQUE_RECIPIENTS_ALL || 8);

const MAX_SINGLE_BUY_SHARE = BigInt(process.env.MAX_SINGLE_BUY_SHARE || "60"); // percent
const MAX_EARLY_SELL_PCT = BigInt(process.env.MAX_EARLY_SELL_PCT || "2");       // percent

const MAX_LOG_RETRIES = Number(process.env.MAX_LOG_RETRIES || 3);

/* ================= HELPERS ================= */
function norm(addr) {
  try {
    return ethers.getAddress(String(addr || "")).toLowerCase();
  } catch {
    return null;
  }
}

const eoaCache = new Map();

async function isEOA(addr) {
  const a = String(addr || "").toLowerCase();
  if (!a) return false;
  if (eoaCache.has(a)) return eoaCache.get(a);

  try {
    const code = await callProvider((p) => p.getCode(a));
    const res = code === "0x";
    eoaCache.set(a, res);
    return res;
  } catch {
    eoaCache.set(a, false);
    return false;
  }
}

async function batchIsEOA(addrs) {
  const unique = [...new Set((addrs || []).map((x) => String(x || "").toLowerCase()))].filter(Boolean);
  for (const a of unique) {
    await isEOA(a);
  }
}

async function resolveTokenFromPair(pair) {
  const lpAddr = norm(pair);
  if (!lpAddr) throw new Error("PAIR_INVALID");

  const lp = new ethers.Contract(lpAddr, PAIR_ABI, provider);

  const [t0Raw, t1Raw] = await Promise.all([
    callProvider((p) => lp.connect(p).token0()),
    callProvider((p) => lp.connect(p).token1())
  ]);

  const t0 = String(t0Raw || "").toLowerCase();
  const t1 = String(t1Raw || "").toLowerCase();

  if (t0 === WBNB) return t1;
  if (t1 === WBNB) return t0;

  throw new Error("PAIR_NOT_WBNB");
}

async function fetchLogsInBatches(address, topic, fromBlock, toBlock, batchSize = 500) {
  const addr = norm(address);
  if (!addr) return [];

  const logs = [];

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);

    for (let r = 0; r < MAX_LOG_RETRIES; r++) {
      try {
        const batch = await callProvider((p) =>
          p.getLogs({ address: addr, topics: [topic], fromBlock: start, toBlock: end })
        );
        logs.push(...batch);
        break;
      } catch {
        rotateRpc();
      }
    }
  }

  return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/* ================= HOLDER CHECK ================= */
async function topHolderCheck(token, pair, logs, supply, maxPct = 15n) {
  const balances = new Map();
  const pairLc = String(pair || "").toLowerCase();

  for (const l of logs) {
    const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
    const val = BigInt(l.data);

    if (![ZERO, DEAD].includes(from)) balances.set(from, (balances.get(from) || 0n) - val);
    if (![ZERO, DEAD].includes(to)) balances.set(to, (balances.get(to) || 0n) + val);
  }

  balances.delete(pairLc);

  const top10Sum = [...balances.entries()]
    .filter(([, v]) => v > 0n)
    .map(([, v]) => v)
    .sort((a, b) => (b > a ? 1 : -1))
    .slice(0, 10)
    .reduce((a, b) => a + b, 0n);

  const pct = supply > 0n ? (top10Sum * 100n) / supply : 100n;
  return pct <= maxPct;
}

/* ================= MARKET HEALTH ================= */
/**
 * marketBehaviorCheck(pairAddress)
 * Returns:
 * {
 *   ok: boolean,
 *   pair: string|null,
 *   token: string|null,
 *   score: number,
 *   isHealthy: boolean,
 *   reasons: string[],
 *   metrics: object
 * }
 */
export async function marketBehaviorCheck(pairAddress) {
  const pair = norm(pairAddress);

  if (!pair) {
    return {
      ok: false,
      isHealthy: false,
      score: 0,
      reasons: ["PAIR_INVALID"],
      pair: null,
      token: null
    };
  }

  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      const token = await resolveTokenFromPair(pair);

      const latest = await callProvider((p) => p.getBlockNumber());
      const fromBlock = Math.max(0, latest - EARLY_SCAN_BLOCKS);

      const logs = await fetchLogsInBatches(token, TRANSFER_TOPIC, fromBlock, latest);
      if (!logs.length) {
        return {
          ok: true,
          pair,
          token,
          isHealthy: false,
          score: 0,
          reasons: ["NO_TRANSFER_LOGS"],
          metrics: {
            realBuyers: 0,
            realSellers: 0,
            buyTxs: 0,
            uniqueRecipientsAll: 0
          }
        };
      }

      const buyers = new Map();
      const sellers = new Map();
      const buyBlocks = new Set();

      let buyTxs = 0;
      const uniqueRecipientsAll = new Set();

      let sold = 0n;

      const slice = logs.slice(0, EARLY_SCAN_LIMIT);

      for (const l of slice) {
        const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
        const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const amt = BigInt(l.data);

        if ([ZERO, DEAD].includes(from) || [ZERO, DEAD].includes(to)) continue;

        // Buy: tokens leaving pair to recipient
        if (from === pair) {
          buyTxs++;
          uniqueRecipientsAll.add(to);

          buyers.set(to, (buyers.get(to) || 0n) + amt);
          buyBlocks.add(l.blockNumber);
        }

        // Sell: tokens coming from sender back to pair
        if (to === pair) {
          sellers.set(from, (sellers.get(from) || 0n) + amt);
          sold += amt;
        }
      }

      const allAddrs = [...new Set([...buyers.keys(), ...sellers.keys()])];
      await batchIsEOA(allAddrs);

      const realBuyers = [...buyers.keys()].filter((a) => eoaCache.get(a) === true);
      const realSellers = [...sellers.keys()].filter((a) => eoaCache.get(a) === true);

      const totalBought = [...buyers.values()].reduce((a, b) => a + b, 0n);
      const maxBuy = [...buyers.values()].reduce((a, b) => (b > a ? b : a), 0n);

      const supply = BigInt(
        await callProvider((p) => new ethers.Contract(token, ERC20_ABI, p).totalSupply())
      );

      const soldPct = supply > 0n ? (sold * 100n) / supply : 100n;
      const maxBuyPct = totalBought > 0n ? (maxBuy * 100n) / totalBought : 100n;

      const buyActivityOk =
        realBuyers.length >= MIN_BUYERS_EOA ||
        buyTxs >= MIN_BUY_TXS ||
        uniqueRecipientsAll.size >= MIN_UNIQUE_RECIPIENTS_ALL;

      const reasons = [];
      if (!buyActivityOk) reasons.push("LOW_BUY_ACTIVITY");
      if (realSellers.length < MIN_SELLERS_EOA) reasons.push("LOW_EOA_SELLERS");
      if (maxBuyPct > MAX_SINGLE_BUY_SHARE) reasons.push("WHALE_DOMINANCE");
      if (soldPct > MAX_EARLY_SELL_PCT) reasons.push("EARLY_SELL_PRESSURE");

      if (buyTxs >= MIN_BUY_TXS && buyBlocks.size < Math.min(3, buyTxs)) {
        reasons.push("BUY_CLUSTERED");
      }

      let holdersOk = false;
      try {
        holdersOk = await topHolderCheck(token, pair, logs, supply);
        if (!holdersOk) reasons.push("TOP10_HOLDER_CONCENTRATION");
      } catch {
        reasons.push("TOPHOLDER_CHECK_ERROR");
      }

      let score = 0;
      score += Math.min(40, realBuyers.length * 3);
      score += Math.min(20, buyBlocks.size * 2);
      if (realSellers.length >= MIN_SELLERS_EOA) score += 10;
      if (soldPct <= MAX_EARLY_SELL_PCT) score += 15;
      if (maxBuyPct <= MAX_SINGLE_BUY_SHARE) score += 15;
      if (holdersOk) score += 10;
      if (score > 70) score = 70;

      const isHealthy = reasons.length === 0;

      return {
        ok: true,
        pair,
        token,
        isHealthy,
        score,
        reasons,
        metrics: {
          realBuyers: realBuyers.length,
          realSellers: realSellers.length,
          buyTxs,
          uniqueRecipientsAll: uniqueRecipientsAll.size,
          soldPct: soldPct.toString(),
          maxBuyPct: maxBuyPct.toString(),
          buyBlocks: buyBlocks.size,
          supply: supply.toString(),
          scannedLogs: logs.length,
          scannedSlice: slice.length,
          scanBlocks: EARLY_SCAN_BLOCKS
        }
      };
    } catch (e) {
      console.warn("marketBehaviorCheck RPC error:", e?.message || e);
      rotateRpc();
    }
  }

  return {
    ok: false,
    pair,
    token: null,
    isHealthy: false,
    score: 0,
    reasons: ["ALL_RPCS_FAILED"]
  };
}

/* ============================================================
   SWAP FEE CHECK FUNCTION
============================================================ */
export async function swapFeeCheck(pairAddress, maxFeePct = 10) {
  const pairAddr = norm(pairAddress);
  if (!pairAddr) return false;

  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);

      const [t0Raw, t1Raw, reserves] = await Promise.all([
        callProvider((p) => pair.connect(p).token0()),
        callProvider((p) => pair.connect(p).token1()),
        callProvider((p) => pair.connect(p).getReserves())
      ]);

      const t0 = String(t0Raw || "").toLowerCase();
      const t1 = String(t1Raw || "").toLowerCase();

      let reserveIn, reserveOut, token;

      const r0 = BigInt(reserves[0]);
      const r1 = BigInt(reserves[1]);

      if (t0 === WBNB) {
        reserveIn = r0;
        reserveOut = r1;
        token = t1Raw;
      } else if (t1 === WBNB) {
        reserveIn = r1;
        reserveOut = r0;
        token = t0Raw;
      } else {
        return false;
      }

      const amountIn = ethers.parseEther("0.01");
      const amountInWithFee = amountIn * 997n;
      const expectedOut =
        (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);

      const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, provider);

      const actualOut = BigInt(
        await callProvider((p) =>
          router.connect(p).getAmountsOut(amountIn, [WBNB, token]).then((r) => r[1].toString())
        )
      );

      const feePct =
        expectedOut > actualOut
          ? Number(((expectedOut - actualOut) * 10000n) / expectedOut) / 100
          : 0;

      return feePct <= maxFeePct;
    } catch (err) {
      console.warn(`swapFeeCheck failed on RPC ${RPC_URLS[rpcIndex]}:`, err?.message || err);
      rotateRpc();
    }
  }

  return false;
}