// file: autoSellToken.js
import fs from "fs";
import crypto from "crypto";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fetch from "node-fetch";
import PQueue from "p-queue";

dotenv.config();

import { markSellStart, markSellComplete, allSellsComplete } from "./sellmonitor.js";

// -------------------- RPCs --------------------
const RPC_URLS = Object.keys(process.env)
  .filter(k => k.startsWith("RPC_URL_"))
  .map(k => process.env[k])
  .filter(Boolean);

if (!RPC_URLS.length) throw new Error("❌ No RPC_URL_* defined in .env");

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

// -------------------- WALLET / ENCRYPTED KEY --------------------
function decryptPrivateKey(ciphertext, passphrase) {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function getWalletFromEnv() {
  const encrypted = process.env.ENCRYPTED_KEY;
  if (!encrypted) throw new Error("ENCRYPTED_KEY missing in env");

  const passphrasePath = process.env.KEY_PASSPHRASE_FILE || "/root/.wallet_pass";
  if (!fs.existsSync(passphrasePath)) {
    throw new Error("Passphrase file missing: " + passphrasePath);
  }

  const passphrase = fs.readFileSync(passphrasePath, "utf8").trim();
  const decrypted = decryptPrivateKey(encrypted, passphrase);
  return new ethers.Wallet(decrypted, provider); // return ethers Wallet instance directly
}

// -------------------- CONFIG --------------------
const PANCAKE_ROUTER =
  process.env.PANCAKE_ROUTER ||
  "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -------------------- PANCAKESWAP ABI --------------------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
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
    console.error("Telegram send failed:", err.message);
  }
}

// -------------------- AUTO SELL --------------------
export async function executeAutoSell(tokenMint) {
  if (!tokenMint) throw new Error("tokenMint required");

  return await withRpcFailover(async (prov) => {
    const wallet = getWalletFromEnv(); // <- uses encrypted key
    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, wallet);

    // 🔔 mark sell start
    await markSellStart(tokenMint);

    // --- fetch wallet token balance ---
    const tokenContract = new ethers.Contract(
      tokenMint,
      ["function balanceOf(address owner) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"],
      wallet
    );

    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance === 0n) {
      console.log(`⚠️ No tokens to sell for ${tokenMint}`);
      await markSellComplete(tokenMint);
      return null;
    }

    // --- approve router ---
    const allowance = await tokenContract.allowance(wallet.address, PANCAKE_ROUTER);
    if (allowance < balance) {
      const approveTx = await tokenContract.approve(PANCAKE_ROUTER, balance);
      await approveTx.wait();
      console.log(`✅ Approved ${tokenMint} for swap`);
    }

    const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const path = [tokenMint, WBNB];

    const amountsOut = await router.getAmountsOut(balance, path);
    const slippage = parseFloat(process.env.SLIPPAGE || "1");
    const amountOutMin = (amountsOut[1] * BigInt(100 - Math.floor(slippage))) / BigInt(100);

    const deadline = Math.floor(Date.now() / 1000) + 20;

    const tx = await router.swapExactTokensForETH(
      balance,
      amountOutMin,
      path,
      wallet.address,
      deadline,
      { gasLimit: 300000 }
    );

    console.log(`✅ Swap submitted: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Swap confirmed: ${tx.hash}`);

    // 🔔 mark sell complete
    await markSellComplete(tokenMint);

    await sendTelegram(`🚀 *SELL EXECUTED*\nToken: ${tokenMint}\nTX: https://bscscan.com/tx/${tx.hash}`);

    return tx.hash;
  });
}