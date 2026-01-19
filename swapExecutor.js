// file: swapExecutor.js
// Adds: file-locking for active_positions.json + checksum normalization
// Adds: buyPrice recording (BNB) using scanedPrice(tokenMint, pairAddress)
// Keeps: stopCaller/startCaller gating with sellmonitor allSellsComplete
// Notes:
// - Canonical storage is CHECKSUM for tokenMint + pairAddress.
// - Identity key is tokenMint (matches your sellmonitor design).
// - sellmonitor can overwrite/maintain files; this module will not fight it.

import fs from "fs";
import { ethers } from "ethers";
import crypto from "crypto";
import dotenv from "dotenv";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { allSellsComplete } from "./sellmonitor.js";
import { scanedPrice } from "./scanedPrice.js";

dotenv.config();

/* ================= RPC FAILOVER ================= */
const RPC_URLS = [
  process.env.RPC_URL_11,
  process.env.RPC_URL_12,
  process.env.RPC_URL_13,
  process.env.RPC_URL_14,
  process.env.RPC_URL_15,
].filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs configured");

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });
let activeRpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

function rotateRpc() {
  activeRpcIndex = (activeRpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);
  console.log(`Switched RPC -> ${RPC_URLS[activeRpcIndex]}`);
}

async function withRpcFailover(fn) {
  let lastError;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      console.warn(`RPC failed (${RPC_URLS[activeRpcIndex]}): ${err?.message || err}`);
      lastError = err;
      rotateRpc();
    }
  }
  throw new Error(`All RPCs failed: ${lastError?.message || "unknown error"}`);
}

/* ================= CONFIG ================= */
const PANCAKE_ROUTER =
  process.env.PANCAKE_ROUTER || "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const ACTIVE_POSITIONS_FILE = "./active_positions.json";
const MAX_ACTIVE_POSITIONS = parseInt(process.env.MAX_ENTRIES || "20", 10);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const OFFLINE_DEFAULT = envBool(process.env.AUTO_BUY_OFFLINE, true);

/* ================= FILE LOCK HELPERS (sync) ================= */
function getLockFile(path) {
  return `${path}.lock`;
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function acquireLockSync(path, timeoutMs = 5000) {
  const lock = getLockFile(path);
  const start = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid || 0));
      fs.closeSync(fd);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        try {
          const st = fs.statSync(lock);
          const age = Date.now() - st.mtimeMs;
          if (age > 60_000) {
            try { fs.unlinkSync(lock); } catch {}
          }
        } catch {}
      }
      sleepSync(15);
    }
  }
}

function releaseLockSync(path) {
  const lock = getLockFile(path);
  try {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {}
}

function safeReadJSONSync(path) {
  acquireLockSync(path);
  try {
    if (!fs.existsSync(path)) return [];
    const raw = fs.readFileSync(path, "utf8");
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } finally {
    releaseLockSync(path);
  }
}

function safeWriteJSONSync(path, data) {
  acquireLockSync(path);
  try {
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, path);
  } finally {
    releaseLockSync(path);
  }
}

function normalizeScanResult(scan) {
  // If scanedPrice returned a NUMBER (default mode)
  if (typeof scan === "number") {
    return {
      ok: true,
      priceBNB: scan
    };
  }

  // If scanedPrice returned the FULL OBJECT (full mode)
  if (scan && typeof scan === "object") {
    return scan;
  }

  // null / undefined / invalid
  return null;
}
/* ================= ADDRESS NORMALIZATION ================= */
function toChecksum(addr) {
  try {
    return ethers.getAddress(String(addr || "").trim());
  } catch {
    return "";
  }
}

/* ================= BUY CONTROL ================= */
let BUY_ALLOWED = true;

export function stopCaller() {
  BUY_ALLOWED = false;
  console.log("stopCaller -> buying disabled");
}

export async function startCaller() {
  if (!BUY_ALLOWED) {
    const sold = await allSellsComplete();
    if (sold) {
      BUY_ALLOWED = true;
      console.log("startCaller -> buying resumed");
    }
  }
  return BUY_ALLOWED;
}



/* ================= WALLET ================= */
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWallet(currentProvider) {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("Passphrase file missing");

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  return new ethers.Wallet(decrypted, currentProvider);
}

/* ================= ABI ================= */
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory)",
];

/* ================= TELEGRAM ================= */
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
      }),
    });
  } catch {}
}

/* ================= ACTIVE POSITIONS NORMALIZATION ================= */
function normalizeActivePositions(activeRaw) {
  const out = [];
  const seen = new Set();

  for (const row of Array.isArray(activeRaw) ? activeRaw : []) {
    const tokenMint = toChecksum(row?.tokenMint || row?.tokenmint);
    const pairAddress = toChecksum(row?.pairAddress || row?.pairaddress);
    const status = String(row?.status || "active");

    if (!tokenMint) continue;
    if (seen.has(tokenMint)) continue;
    seen.add(tokenMint);

    const buyPrice = Number(row?.buyPrice ?? row?.buyprice ?? 0);
    const ts = Number(row?.timestamp || Date.now());

    out.push({
      tokenMint,
      pairAddress: pairAddress || "",
      status,
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
      buyPrice: Number.isFinite(buyPrice) ? buyPrice : 0,
      txHash: row?.txHash || row?.txhash || undefined,
      soldAt: row?.soldAt ?? row?.soldat,
    });
  }

  return out;
}

function readTradeConfig() {
  const p = "./trade_config.json";
  if (!fs.existsSync(p)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));

    return {
      tradePerEntry: Number(data?.tradePerEntry) || 0,
      requirements: data?.requirements || {}
    };
  } catch {
    return null;
  }
}

/* ================= BUY PRICE HELPER ================= */
async function getBuyPriceBNB(tokenMint, pairAddress) {
  try {
    if (!tokenMint || !pairAddress) return 0;

    const scanRaw = await scanedPrice(tokenMint, pairAddress); // number (default) OR object (full)
    const scan = normalizeScanResult(scanRaw);
    if (!scan) return 0;

    const p = Number(scan.priceBNB);
    return Number.isFinite(p) && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}
/* ================= ENV BOOLEAN PARSER ================= */

function envBool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}



/**
 * ================================================
 * AUTO BUY TOKEN
 * - Uses CHECKSUM addresses
 * - Locks and normalizes active_positions.json
 * - Records buyPrice (BNB) at time of buy
 * ================================================
 */
export async function autoBuyToken(
  tokenMintRaw,
  pairAddressRaw,
  { offline = OFFLINE_DEFAULT } = {}
) {
  console.log("autoBuyToken entered with:", {
    tokenMintRaw,
    pairAddressRaw,
    offline
  });

  if (!(await startCaller())) {
    console.log("startCaller() returned false, aborting trade");
    return null;
  }

  const tokenMint = toChecksum(tokenMintRaw);
  const pairAddress = toChecksum(pairAddressRaw);

  if (!tokenMint) {
    console.warn("Invalid tokenMint:", tokenMintRaw);
    return null;
  }

  // Only require pairAddress for LIVE mode
  if (!offline && !pairAddress) {
    console.warn("Invalid pairAddress:", pairAddressRaw);
    return null;
  }

  const tradeCfg = readTradeConfig();
const tradeAmount = Number(tradeCfg?.tradePerEntry || 0);

if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) {
  console.log("Trade config missing or tradePerEntry <= 0");
  return null;
}

  // Normalize once, keep canonical checksum storage
  const normalizedNow = (() => {
    const raw = safeReadJSONSync(ACTIVE_POSITIONS_FILE);
    const normalized = normalizeActivePositions(raw);
    safeWriteJSONSync(ACTIVE_POSITIONS_FILE, normalized);
    return normalized;
  })();

  const activeCount = normalizedNow.filter((p) => p.status !== "sold").length;
  if (activeCount >= MAX_ACTIVE_POSITIONS) {
    console.log("Max active positions reached, stopping caller");
    stopCaller();
    return null;
  }

  // Pre-buy buyPrice snapshot (BNB per token)
  const buyPrice = offline ? 0 : await getBuyPriceBNB(tokenMint, pairAddress);

  return await withRpcFailover(async (prov) => {
    const wallet = getWallet(prov);
    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, wallet);

    const WBNB = toChecksum(process.env.WBNB_ADDRESS);
    if (!WBNB) {
      console.error("WBNB_ADDRESS missing/invalid");
      return null;
    }

    const path = [WBNB, tokenMint];
    const amountIn = ethers.parseEther(tradeAmount.toString());
    const slippage = parseFloat(process.env.SLIPPAGE || "1");

    // ================= LIVE MODE =================
    if (!offline) {
      let amountsOut;
      try {
        amountsOut = await router.getAmountsOut(amountIn, path);
      } catch (err) {
        console.error("Failed to fetch amountsOut:", err?.message || err);
        return null;
      }

      const amountOutMin =
        (amountsOut[1] * BigInt(100 - Math.floor(slippage))) / BigInt(100);
      const deadline = Math.floor(Date.now() / 1000) + 20;

      let tx;
      try {
        tx = await router.swapExactETHForTokens(
          amountOutMin,
          path,
          wallet.address,
          deadline,
          { value: amountIn, gasLimit: 300_000 }
        );
        console.log(`Swap sent: ${tx.hash}`);
        await tx.wait();
        console.log(`Swap confirmed: ${tx.hash}`);
      } catch (err) {
        console.error("Swap transaction failed:", err?.message || err);
        return null;
      }

      // Record active position
      acquireLockSync(ACTIVE_POSITIONS_FILE);
      try {
        const raw = fs.existsSync(ACTIVE_POSITIONS_FILE)
          ? JSON.parse(fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8") || "[]")
          : [];
        const normalized = normalizeActivePositions(raw);

        const existsActive = normalized.some(
          (p) => p.tokenMint === tokenMint && p.status !== "sold"
        );

        if (!existsActive) {
          normalized.push({
            tokenMint,
            buyPrice: Number.isFinite(buyPrice) ? buyPrice : 0,
            timestamp: Date.now(),
            status: "active",
            pairAddress: pairAddress || "",
            txHash: tx.hash
          });
        }

        const tmp = `${ACTIVE_POSITIONS_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
        fs.renameSync(tmp, ACTIVE_POSITIONS_FILE);
      } catch (e) {
        console.error("Failed to record active position:", e?.message || e);
      } finally {
        releaseLockSync(ACTIVE_POSITIONS_FILE);
      }

      await sendTelegram(
        `🚀 *BUY EXECUTED*\nToken: ${tokenMint}\nPair: ${pairAddress}\nBuyPrice: ${Number(buyPrice || 0).toFixed(12)} BNB\nTX: https://bscscan.com/tx/${tx.hash}`
      );

      return tx.hash;
    }

    // ================= OFFLINE MODE =================
    console.log("Running in OFFLINE mode");
    console.log("[Offline] Decrypting wallet and simulating buy (no execution)");

    // 1) Wallet decrypt proof
    console.log("[Offline] Wallet address:", wallet.address);

    // 2) Balance check (BNB)
    let balanceWei = 0n;
    try {
      const bal = await prov.getBalance(wallet.address);
      balanceWei = BigInt(bal);
    } catch (e) {
      console.warn("[Offline] Could not read wallet balance:", e?.message || e);
    }

    const balanceBNB = Number(ethers.formatUnits(balanceWei, 18));
    console.log("[Offline] Wallet balance (BNB):", balanceBNB);

    // 3) Show trade intent (no swap)
    const amountInBNB = Number(tradeAmount);
    console.log("[Offline] tokenMint:", tokenMint);
    console.log("[Offline] pairAddress:", pairAddress || "(none)");
    console.log("[Offline] tradeAmount (BNB):", amountInBNB);
    console.log("[Offline] amountIn (wei):", amountIn.toString());
    console.log("[Offline] slippage (%):", slippage);

    const enough = Number.isFinite(balanceBNB) && Number.isFinite(amountInBNB) && balanceBNB >= amountInBNB;

    if (!enough) {
      console.log("[Offline] Not enough balance to trade (expected in tests).");
      console.log("[Offline] Needed:", amountInBNB, "BNB");
      console.log("[Offline] Have  :", balanceBNB, "BNB");
    } else {
      console.log("[Offline] Balance is sufficient for the intended trade amount (still no execution in offline mode).");
    }

    // 4) Optional: read-only quote (still no swap)
    try {
      const amountsOut = await router.getAmountsOut(amountIn, path);
      console.log("[Offline] getAmountsOut OK:", amountsOut?.map((x) => x.toString()));
    } catch (e) {
      console.log("[Offline] getAmountsOut failed (non-fatal):", e?.message || e);
    }

    // 5) Mock record (no swap)
    const mockTxHash =
      "0xMOCKTXHASH000000000000000000000000000000000000000000000000000000";
    console.log(`[Offline] Mock buy recorded: ${mockTxHash}`);

    acquireLockSync(ACTIVE_POSITIONS_FILE);
    try {
      const raw = fs.existsSync(ACTIVE_POSITIONS_FILE)
        ? JSON.parse(fs.readFileSync(ACTIVE_POSITIONS_FILE, "utf8") || "[]")
        : [];
      const normalized = normalizeActivePositions(raw);

      const existsActive = normalized.some(
        (p) => p.tokenMint === tokenMint && p.status !== "sold"
      );

      if (!existsActive) {
        normalized.push({
          tokenMint,
          buyPrice: 0,
          timestamp: Date.now(),
          status: "mock-active",
          pairAddress: pairAddress || "0x0000000000000000000000000000000000000000",
          txHash: mockTxHash
        });
      }

      const tmp = `${ACTIVE_POSITIONS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
      fs.renameSync(tmp, ACTIVE_POSITIONS_FILE);
    } catch (e) {
      console.error("Failed to record mock position:", e?.message || e);
    } finally {
      releaseLockSync(ACTIVE_POSITIONS_FILE);
    }

    return mockTxHash;
  });
}