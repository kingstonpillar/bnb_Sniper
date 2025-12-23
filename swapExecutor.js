// file: swapExecutor.js
import fs from "fs";
import { ethers } from "ethers";
import crypto from "crypto";
import dotenv from "dotenv";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { allSellsComplete } from "./sellmonitor.js";
import { swapFeeCheck } from "./marketHealth.js";

dotenv.config();

/* ================= RPC FAILOVER ================= */
const RPC_URLS = [
  process.env.RPC_URL_11,
  process.env.RPC_URL_12,
  process.env.RPC_URL_13,
  process.env.RPC_URL_14,
  process.env.RPC_URL_15,
].filter(Boolean);

if (!RPC_URLS.length) {
  throw new Error("❌ No RPC URLs configured");
}

const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });
let activeRpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);

function rotateRpc() {
  activeRpcIndex = (activeRpcIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[activeRpcIndex]);
  console.log(`➡️ Switched RPC → ${RPC_URLS[activeRpcIndex]}`);
}

async function withRpcFailover(fn) {
  let lastError;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      console.warn(`⚠️ RPC failed (${RPC_URLS[activeRpcIndex]}): ${err.message}`);
      lastError = err;
      rotateRpc();
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message}`);
}

/* ================= CONFIG ================= */
const PANCAKE_ROUTER =
  process.env.PANCAKE_ROUTER ||
  "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const ACTIVE_POSITIONS_FILE = "./active_positions.json";
const MAX_ACTIVE_POSITIONS = parseInt(process.env.MAX_ENTRIES || "20");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* ================= BUY CONTROL ================= */
let BUY_ALLOWED = true;

export function stopCaller() {
  BUY_ALLOWED = false;
  console.log("🛑 stopCaller → buying disabled");
}

export async function startCaller() {
  if (!BUY_ALLOWED) {
    const sold = await allSellsComplete();
    if (sold) {
      BUY_ALLOWED = true;
      console.log("✅ startCaller → buying resumed");
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

  const passphrasePath =
    process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath))
    throw new Error("Passphrase file missing");

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

/* ================= JSON ================= */
function safeReadJSON(p) {
  try {
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function safeWriteJSON(p, v) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

function readTradeConfig() {
  if (!fs.existsSync("./trade_config.json")) return null;
  try {
    const data = JSON.parse(fs.readFileSync("./trade_config.json", "utf8"));
    return data.tradePerEntry ? Number(data.tradePerEntry) : null;
  } catch {
    return null;
  }
}


/**
 * ================================================
 * 🚀 AUTO BUY TOKEN
 * Automated Token Purchase with Swap Fee Check & RPC Failover
 * ================================================
 */


export async function autoBuyToken(tokenMintRaw, pairAddressRaw, { offline = true } = {}) {
  console.log("➡️ autoBuyToken entered with:", tokenMintRaw, pairAddressRaw);

  if (!(await startCaller())) {
    console.log("⚠️ startCaller() returned false, aborting trade");
    return null;
  }

  // ✅ Ensure inputs are valid Ethereum addresses or fallback in offline mode
  let tokenMint, pairAddress;
  try {
    tokenMint = ethers.getAddress(tokenMintRaw);
    pairAddress = offline 
      ? pairAddressRaw || "0x0000000000000000000000000000000000000000" // placeholder in offline mode
      : ethers.getAddress(pairAddressRaw);
  } catch (err) {
    console.warn("⚠️ Invalid address provided:", err);
    if (offline) {
      // Allow mock test with placeholder address
      tokenMint = tokenMintRaw;
      pairAddress = pairAddressRaw || "0x0000000000000000000000000000000000000000";
    } else {
      return null;
    }
  }

  // 1️⃣ Check swap fee BEFORE executing trade (skip if offline)
  if (!offline) {
    const feeOk = await swapFeeCheck(tokenMint, pairAddress);
    if (!feeOk) {
      console.log(`❌ Swap aborted for ${tokenMint}: fee too high`);
      return null;
    }
  }

  // 2️⃣ Load trade amount from config
  const tradeAmount = readTradeConfig();
  if (!tradeAmount || tradeAmount <= 0) {
    console.log("⚠️ Trade config missing or tradePerEntry = 0");
    return null;
  }

  // 3️⃣ Check active positions
  const active = safeReadJSON(ACTIVE_POSITIONS_FILE);
  const activeCount = active.filter(p => p.status !== "sold").length;
  if (activeCount >= MAX_ACTIVE_POSITIONS) {
    console.log("⚠️ Max active positions reached, stopping caller");
    stopCaller();
    return null;
  }

  // 4️⃣ Execute swap (or simulate if offline)
  return await withRpcFailover(async (prov) => {
    const wallet = getWallet(prov);
    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, wallet);

    const WBNB = ethers.getAddress(process.env.WBNB_ADDRESS);
    const path = [WBNB, tokenMint];
    const amountIn = ethers.parseEther(tradeAmount.toString());
    const slippage = parseFloat(process.env.SLIPPAGE || "1");

    if (!offline) {
      // ✅ Calculate min output and send transaction
      let amountsOut;
      try {
        amountsOut = await router.getAmountsOut(amountIn, path);
      } catch (err) {
        console.error("❌ Failed to fetch amountsOut:", err);
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
        console.log(`🚀 Swap sent: ${tx.hash}`);
        await tx.wait();
        console.log(`✅ Swap confirmed: ${tx.hash}`);
      } catch (err) {
        console.error("❌ Swap transaction failed:", err);
        return null;
      }

      // 5️⃣ Record active position
      active.push({
        tokenMint,
        pairAddress,
        status: "active",
        timestamp: Date.now(),
        txHash: tx.hash,
      });
      safeWriteJSON(ACTIVE_POSITIONS_FILE, active);

      // 6️⃣ Notify via Telegram
      await sendTelegram(
        `🚀 *BUY EXECUTED*\nToken: ${tokenMint}\nPair: ${pairAddress}\nTX: https://bscscan.com/tx/${tx.hash}`
      );

      return tx.hash;
    } else {
      // 🔹 Offline mock mode
      console.log("🧪 [Offline] Simulating swap...");
      const mockTxHash = "0xMOCKTXHASH000000000000000000000000000000000000000000000000000000";
      console.log(`✅ [Offline] Mock swap executed: ${mockTxHash}`);

      // Record mock position
      active.push({
        tokenMint,
        pairAddress,
        status: "mock-active",
        timestamp: Date.now(),
        txHash: mockTxHash,
      });
      safeWriteJSON(ACTIVE_POSITIONS_FILE, active);

      return mockTxHash;
    }
  });
}