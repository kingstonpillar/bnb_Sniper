// file: lpDrainMonitor.js
import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= PAIR ABI ================= */
const PAIR_ABI = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)",
  "function token1() view returns(address)"
];

/* ================= HELPERS ================= */
function norm(addr, label = "address") {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    throw new Error(`INVALID_${label.toUpperCase()}`);
  }
}

function nowMs() {
  return Date.now();
}

// bps change from prev -> cur. Positive means increase, negative means decrease.
function deltaBps(cur, prev) {
  // BigInt
  if (prev <= 0n) return 0;
  return Number(((cur - prev) * 10000n) / prev);
}

// price = (wbnbReserve / tokenReserve). Return scaled price as BigInt with 1e18 scale.
function priceScaled(wbnbReserve, tokenReserve) {
  if (tokenReserve <= 0n) return 0n;
  return (wbnbReserve * 1000000000000000000n) / tokenReserve; // 1e18
}

// percent move in bps between prices: (cur-prev)/prev in bps
function priceMoveBps(curPriceScaled, prevPriceScaled) {
  if (prevPriceScaled <= 0n) return 0;
  return Number(((curPriceScaled - prevPriceScaled) * 10000n) / prevPriceScaled);
}

/* ================= MONITOR ================= */
export class LPDrainMonitor {
  constructor(
    pairAddress,
    wbnbAddress,
    pollIntervalMs = 10_000,
    cooldownMinutes = 2,
    opts = {}
  ) {
    /* ================= RPC SETUP ================= */
    this.RPC_URLS = [process.env.READ_RPC_1, process.env.READ_RPC_2].filter(Boolean);
    if (this.RPC_URLS.length < 2) {
      throw new Error("READ_RPC_1 and READ_RPC_2 must be defined in .env");
    }

    this.rpcIndex = 0;
    this.provider = new ethers.JsonRpcProvider(this.RPC_URLS[this.rpcIndex]);

    /* ================= QUEUE ================= */
    this.queue = new PQueue({
      concurrency: 1,
      intervalCap: 2,
      interval: 250,
      carryoverConcurrencyCount: true
    });

    /* ================= CONFIG ================= */
    this.pairAddress = norm(pairAddress, "PAIR");
    this.WBNB = norm(wbnbAddress, "WBNB");

    this.pollIntervalMs = pollIntervalMs;
    this.cooldownMs = cooldownMinutes * 60 * 1000;
    this.cooldownUntil = 0;

    // Thresholds (bps)
    this.DRAIN_MIN_BPS = Number.isFinite(opts.drainMinBps) ? opts.drainMinBps : 250; // 2.50%
    this.HEAVY_SELL_PRICE_DROP_BPS = Number.isFinite(opts.heavySellPriceDropBps)
      ? opts.heavySellPriceDropBps
      : 500; // 5.00%
    this.LIGHT_SELL_PRICE_DROP_BPS = Number.isFinite(opts.lightSellPriceDropBps)
      ? opts.lightSellPriceDropBps
      : 150; // 1.50%

    this.prev = null; // { tokenReserve, wbnbReserve, price }
    this.running = false;
    this.listeners = [];
    this.timer = null;
  }

  /* ================= RPC FAILOVER ================= */
  rotateRpc() {
    this.rpcIndex = (this.rpcIndex + 1) % this.RPC_URLS.length;
    this.provider = new ethers.JsonRpcProvider(this.RPC_URLS[this.rpcIndex]);
  }

  async withRpc(fn) {
    let lastErr;
    for (let i = 0; i < this.RPC_URLS.length; i++) {
      try {
        return await this.queue.add(() => fn(this.provider));
      } catch (e) {
        lastErr = e;
        this.rotateRpc();
      }
    }
    throw lastErr;
  }

  /* ================= LISTENERS ================= */
  onSignal(cb) {
    if (typeof cb === "function") this.listeners.push(cb);
  }

  emit(status) {
    for (const cb of this.listeners) {
      try {
        cb(status);
      } catch {
        // ignore listener errors
      }
    }
  }

  /* ================= FETCH RESERVES ================= */
  async fetchReserves() {
    return this.withRpc(async (prov) => {
      const pair = new ethers.Contract(this.pairAddress, PAIR_ABI, prov);

      const [res, t0, t1] = await Promise.all([pair.getReserves(), pair.token0(), pair.token1()]);

      const r0 = BigInt(res[0]);
      const r1 = BigInt(res[1]);

      const token0 = String(t0).toLowerCase();
      const token1 = String(t1).toLowerCase();

      // Identify which reserve is WBNB and which is token
      if (token0 === this.WBNB) {
        return { wbnbReserve: r0, tokenReserve: r1 };
      }
      if (token1 === this.WBNB) {
        return { wbnbReserve: r1, tokenReserve: r0 };
      }

      throw new Error("PAIR_NOT_WBNB");
    });
  }

  /* ================= CORE LOGIC ================= */
  async check() {
    const ts = nowMs();

    try {
      const curRes = await this.fetchReserves();
      const curPrice = priceScaled(curRes.wbnbReserve, curRes.tokenReserve);

      let safeToBuy = true;
      let reason = "STABLE";

      // Cooldown gate
      if (ts < this.cooldownUntil) {
        safeToBuy = false;
        reason = "COOLDOWN";
      }

      if (this.prev && reason !== "COOLDOWN") {
        const prevRes = this.prev;

        const tokenDeltaBps = deltaBps(curRes.tokenReserve, prevRes.tokenReserve);
        const wbnbDeltaBps = deltaBps(curRes.wbnbReserve, prevRes.wbnbReserve);

        const pMoveBps = priceMoveBps(curPrice, prevRes.price);

        // LP drain: both reserves down beyond threshold
        const tokenDrain = tokenDeltaBps <= -this.DRAIN_MIN_BPS;
        const wbnbDrain = wbnbDeltaBps <= -this.DRAIN_MIN_BPS;

        if (tokenDrain && wbnbDrain) {
          safeToBuy = false;
          reason = "LP_DRAIN";
          this.cooldownUntil = ts + this.cooldownMs;
        } else {
          // Sell pressure heuristic:
          // tokenReserve increases and wbnbReserve decreases, plus price drops
          const tokenUp = tokenDeltaBps > 0;
          const wbnbDown = wbnbDeltaBps < 0;

          if (tokenUp && wbnbDown) {
            if (pMoveBps <= -this.HEAVY_SELL_PRICE_DROP_BPS) {
              safeToBuy = false;
              reason = "HEAVY_SELL_PRESSURE";
            } else if (pMoveBps <= -this.LIGHT_SELL_PRICE_DROP_BPS) {
              reason = "LIGHT_SELL_PRESSURE";
            } else {
              reason = "SELL_FLOW_NO_PRICE_BREAK";
            }
          }

          // Buy pressure heuristic:
          // tokenReserve decreases and wbnbReserve increases
          const tokenDown = tokenDeltaBps < 0;
          const wbnbUp = wbnbDeltaBps > 0;

          if (tokenDown && wbnbUp) {
            reason = "BUY_PRESSURE";
          }
        }
      }

      // update prev snapshot
      this.prev = { ...curRes, price: curPrice };

      const status = {
        ok: true,
        safeToBuy,
        reason,
        pairAddress: this.pairAddress,
        reserves: {
          tokenReserve: curRes.tokenReserve.toString(),
          wbnbReserve: curRes.wbnbReserve.toString()
        },
        priceScaled: curPrice.toString(), // wbnb/token scaled 1e18
        timestamp: ts,
        rpc: this.RPC_URLS[this.rpcIndex],
        cooldownUntil: this.cooldownUntil
      };

      this.emit(status);
      return status;
    } catch (e) {
      const status = {
        ok: false,
        safeToBuy: false,
        reason: e?.message === "PAIR_NOT_WBNB" ? "PAIR_NOT_WBNB" : "RPC_ERROR",
        pairAddress: this.pairAddress,
        timestamp: ts,
        rpc: this.RPC_URLS[this.rpcIndex],
        error: e?.message || String(e)
      };
      this.emit(status);
      return status;
    }
  }

  /* ================= LIFECYCLE ================= */
  start() {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      this.check();
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }
}