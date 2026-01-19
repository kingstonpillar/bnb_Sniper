// file: autoSellToken.js
import fs from "fs";
import crypto from "crypto";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fetch from "node-fetch";
import PQueue from "p-queue";

dotenv.config();

import { markSellStart, markSellComplete } from "./sellmonitor.js";

// -------------------- RPCs --------------------
const RPC_URLS = Object.keys(process.env)
  .filter(k => k.startsWith("RPC_URL_"))
  .map(k => process.env[k])
  .filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC_URL_* defined in .env");

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
      console.warn(`RPC failed (${RPC_URLS[activeRpcIndex]}): ${err.message}`);
      lastError = err;
      rotateRpc();
    }
  }
  throw new Error(`All RPCs failed: ${lastError?.message || "unknown error"}`);
}

// -------------------- HELPERS --------------------
function toChecksum(addr) {
  try {
    return ethers.getAddress(String(addr || "").trim());
  } catch {
    return "";
  }
}
/* ================= ENV BOOLEAN PARSER ================= */
function envBool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}

// -------------------- WALLET / ENCRYPTED KEY --------------------
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWalletFromEnv(prov) {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) throw new Error("Passphrase file missing: " + passphrasePath);

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  return new ethers.Wallet(decrypted, prov);
}

// -------------------- CONFIG --------------------
const PANCAKE_ROUTER =
  process.env.PANCAKE_ROUTER ||
  "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const WBNB = toChecksum(process.env.WBNB_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
if (!WBNB) throw new Error("WBNB_ADDRESS missing/invalid");

// -------------------- ABIs --------------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// -------------------- TELEGRAM --------------------
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
  } catch (err) {
    console.error("Telegram send failed:", err?.message || err);
  }
}

// -------------------- AUTO SELL --------------------
export async function executeAutoSell(tokenMintRaw, { dryRun = envBool(process.env.AUTO_SELL_DRY_RUN, true) } = {}) {
  const tokenMint = toChecksum(tokenMintRaw);
  if (!tokenMint) throw new Error("tokenMint invalid");

  return await withRpcFailover(async (prov) => {
    const wallet = getWalletFromEnv(prov);
    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, wallet);

    markSellStart(tokenMint);

    try {
      console.log("[Sell] Wallet:", wallet.address);
      console.log("[Sell] Token :", tokenMint);
      console.log("[Sell] DRY RUN:", dryRun);

      const tokenContract = new ethers.Contract(tokenMint, ERC20_ABI, wallet);

      const balance = await tokenContract.balanceOf(wallet.address);
      console.log("[Sell] Token balance (raw):", balance.toString());

      // If no token balance, report clearly and exit (this is your expected case)
      if (balance === 0n) {
        console.log("[Sell] No token funds to sell. Exiting.");
        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            reason: "NO_TOKEN_FUNDS",
            wallet: wallet.address,
            token: tokenMint,
            balance: "0"
          };
        }
        return null;
      }

      const allowance = await tokenContract.allowance(wallet.address, PANCAKE_ROUTER);
      console.log("[Sell] Allowance (raw):", allowance.toString());

      const path = [tokenMint, WBNB];

      // Quote
      let amountsOut;
      try {
        amountsOut = await router.getAmountsOut(balance, path);
        console.log("[Sell] getAmountsOut:", amountsOut.map((x) => x.toString()));
      } catch (e) {
        console.log("[Sell] getAmountsOut failed:", e?.message || e);
        if (dryRun) {
          return {
            ok: false,
            dryRun: true,
            reason: "GET_AMOUNTS_OUT_FAILED",
            error: String(e?.message || e)
          };
        }
        throw e;
      }

      const slippage = parseFloat(process.env.SLIPPAGE || "1");
      const amountOutMin = (amountsOut[1] * BigInt(100 - Math.floor(slippage))) / BigInt(100);
      const deadline = Math.floor(Date.now() / 1000) + 20;

      // DRY RUN: do not approve, do not send swap, only simulate
      if (dryRun) {
        console.log("[Sell][DRY] Simulating approval need...");
        const needsApprove = allowance < balance;

        console.log("[Sell][DRY] Needs approve:", needsApprove);
        console.log("[Sell][DRY] Would swapExactTokensForETH with:");
        console.log("  amountIn     :", balance.toString());
        console.log("  amountOutMin :", amountOutMin.toString());
        console.log("  to           :", wallet.address);
        console.log("  deadline     :", deadline);

        // Try callStatic swap to see if it would revert
        try {
          // ethers v6: callStatic is under "staticCall" pattern
          // For contracts, you can do: router.swapExactTokensForETH.staticCall(...)
          const res = await router.swapExactTokensForETH.staticCall(
            balance,
            amountOutMin,
            path,
            wallet.address,
            deadline
          );

          console.log("[Sell][DRY] swap staticCall OK:", res.map((x) => x.toString()));
          return {
            ok: true,
            dryRun: true,
            reason: "SWAP_STATIC_OK",
            wallet: wallet.address,
            token: tokenMint,
            balance: balance.toString(),
            amountOutMin: amountOutMin.toString()
          };
        } catch (e) {
          console.log("[Sell][DRY] swap staticCall REVERTED (expected if no allowance / router restrictions):", e?.shortMessage || e?.message || e);
          return {
            ok: false,
            dryRun: true,
            reason: "SWAP_STATIC_REVERT",
            error: String(e?.shortMessage || e?.message || e)
          };
        }
      }

      // LIVE MODE: approve if needed, then send swap
      if (allowance < balance) {
        const approveTx = await tokenContract.approve(PANCAKE_ROUTER, balance);
        await approveTx.wait();
      }

      const tx = await router.swapExactTokensForETH(
        balance,
        amountOutMin,
        path,
        wallet.address,
        deadline,
        { gasLimit: 300000 }
      );

      await tx.wait();

      await sendTelegram(` *SELL EXECUTED*\nToken: ${tokenMint}\nTX: https://bscscan.com/tx/${tx.hash}`);

      return tx.hash;
    } finally {
      markSellComplete(tokenMint);
    }
  });
}