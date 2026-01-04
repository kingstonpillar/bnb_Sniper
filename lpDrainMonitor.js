import "dotenv/config";
import { ethers } from "ethers";
import PQueue from "p-queue";

/* ================= PAIR ABI ================= */
const PAIR_ABI = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)"
];

/* ================= MARKET PRESSURE MONITOR ================= */
export class MarketPressureMonitor {
  constructor(
    pairAddress,
    tokenIn,
    pollInterval = 10_000,
    cooldownMinutes = 2
  ) {
    /* ================= RPC SETUP ================= */
    this.RPC_URLS = [
      process.env.READ_RPC_1,
      process.env.READ_RPC_2
    ];

    if (!this.RPC_URLS[0] || !this.RPC_URLS[1]) {
      throw new Error("READ_RPC_1 and READ_RPC_2 must be defined in .env");
    }

    this.rpcIndex = 0;
    this.provider = new ethers.JsonRpcProvider(this.RPC_URLS[this.rpcIndex]);

    /* ================= QUEUE ================= */
    this.queue = new PQueue({
      concurrency: 1,
      intervalCap: 1,
      interval: 200
    });

    /* ================= CONFIG ================= */
    this.pairAddress = ethers.getAddress(pairAddress);
    this.tokenIn = ethers.getAddress(tokenIn);

    this.pollInterval = pollInterval;
    this.cooldownMs = cooldownMinutes * 60 * 1000;
    this.cooldownUntil = 0;

    this.prev = null;
    this.running = false;
    this.listeners = [];
  }

  /* ================= RPC FAILOVER ================= */
  rotateRpc() {
    this.rpcIndex = (this.rpcIndex + 1) % this.RPC_URLS.length;
    this.provider = new ethers.JsonRpcProvider(this.RPC_URLS[this.rpcIndex]);
    console.warn("🔁 RPC failover →", this.RPC_URLS[this.rpcIndex]);
  }

  async call(fn) {
    return this.queue.add(async () => {
      try {
        return await fn(this.provider);
      } catch (err) {
        console.warn("RPC error, switching provider:", err.message);
        this.rotateRpc();
        return await fn(this.provider); // retry once on backup
      }
    });
  }

  /* ================= LISTENERS ================= */
  onSignal(cb) {
    this.listeners.push(cb);
  }

  emit(status) {
    for (const cb of this.listeners) cb(status);
  }

  /* ================= FETCH RESERVES ================= */
  async fetchReserves() {
    const [reserves, token0] = await this.call(async (provider) => {
      const pair = new ethers.Contract(
        this.pairAddress,
        PAIR_ABI,
        provider
      );

      return Promise.all([
        pair.getReserves(),
        pair.token0()
      ]);
    });

    const [r0, r1] = reserves;

    return token0.toLowerCase() === this.tokenIn.toLowerCase()
      ? { tokenIn: r0, token: r1 }
      : { tokenIn: r1, token: r0 };
  }

  /* ================= CORE LOGIC ================= */
  async check() {
    try {
      const cur = await this.fetchReserves();

      let safeToBuy = true;
      let reason = "STABLE";

      if (this.prev) {
        const dToken   = Number(cur.token   - this.prev.token);
        const dTokenIn = Number(cur.tokenIn - this.prev.tokenIn);

        const prevPrice = Number(this.prev.tokenIn) / Number(this.prev.token);
        const curPrice  = Number(cur.tokenIn) / Number(cur.token);
        const priceMove = ((curPrice - prevPrice) / prevPrice) * 100;

        /* 🔥 LP DRAIN */
        if (dToken < 0 && dTokenIn < 0) {
          safeToBuy = false;
          reason = "LP_DRAIN";
          this.cooldownUntil = Date.now() + this.cooldownMs;
        }

        /* 📉 SELL PRESSURE */
        else if (dToken > 0 && dTokenIn < 0) {
          if (priceMove < -5) {
            safeToBuy = false;
            reason = "HEAVY_SELL_PRESSURE";
          } else {
            reason = "LIGHT_SELL_PRESSURE";
          }
        }

        /* 🚀 BUY PRESSURE */
        else if (dToken < 0 && dTokenIn > 0) {
          reason = "BUY_PRESSURE";
        }
      }

      /* ⏱️ COOLDOWN */
      if (Date.now() < this.cooldownUntil) {
        safeToBuy = false;
        reason = "COOLDOWN";
      }

      this.prev = cur;

      const status = {
        safeToBuy,
        reason,
        reserves: cur,
        timestamp: Date.now(),
        rpc: this.RPC_URLS[this.rpcIndex]
      };

      this.emit(status);
      return status;

    } catch (err) {
      console.error("MarketPressureMonitor fatal error:", err.message || err);
      return {
        safeToBuy: false,
        reason: "RPC_ERROR",
        timestamp: Date.now()
      };
    }
  }

  /* ================= LIFECYCLE ================= */
  start() {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      this.check();
    }, this.pollInterval);

    console.log("📊 MarketPressureMonitor started:", this.pairAddress);
  }

  stop() {
    clearInterval(this.timer);
    this.running = false;
    console.log("🛑 MarketPressureMonitor stopped:", this.pairAddress);
  }
}