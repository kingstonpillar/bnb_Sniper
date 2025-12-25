import fs from "fs";
import fetch from "node-fetch";
import { autoBuyToken } from "./swapExecutor.js";
import { securityPerfect } from "./securityPerfect.js";
import { securitySafety } from "./securitycheck2.js";
import { scanedPrice } from "./scanedPrice.js";
import { liquidityLock } from "./liquidityCheck.js";
import { marketHealthPass } from "./marketHealth.js";
import { walletRate } from "./walletHistory.js";
import PQueue from "p-queue";

const POTENTIAL_MIGRATORS = "./potential_migrators.json";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -------------------- RPC QUEUE --------------------
const rpcQueue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 5 });

// -------------------- JSON HANDLERS --------------------
function loadMigrators() {
  if (!fs.existsSync(POTENTIAL_MIGRATORS)) return [];
  try {
    return JSON.parse(fs.readFileSync(POTENTIAL_MIGRATORS, "utf8"));
  } catch {
    return [];
  }
}

function saveMigrators(data) {
  fs.writeFileSync(POTENTIAL_MIGRATORS, JSON.stringify(data, null, 2));
}

// -------------------- TELEGRAM --------------------
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
  } catch (err) {
    console.warn("Telegram send failed:", err.message);
  }
}

// -------------------- TREND LOGIC --------------------
function trendConfirmed(candles, rise) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return rise >= 0.10 && last.high > prev.high && last.low > prev.low;
}

function reverseDetected(candles, rise) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (rise > 0.12 && last.low < prev.low) return true;
  if (last.high < prev.high && prev.high < candles[candles.length - 3]?.high) return true;
  return false;
}

// -------------------- PERSISTENCE --------------------
function updateTrendPersistence(token, candles) {
  if (!token.trendPersistence) token.trendPersistence = 0;
  const rise = (candles[candles.length - 1].close - token.entryPrice) / token.entryPrice;
  if (trendConfirmed(candles, rise)) token.trendPersistence += 1;
  else token.trendPersistence = 0;
}

// -------------------- PROCESS SINGLE TOKEN --------------------
async function processToken(token) {
  const tokenMint = token.tokenmint.toLowerCase();
  const pairAddress = token.pairaddress.toLowerCase();
  const now = Date.now();

  try {
    // -------------------- STATIC SECURITY --------------------
    if (!token.staticChecked) {
      const [secPerfect, secSafety, liqLocked, walletRes] = await Promise.all([
        securityPerfect(pairAddress),
        securitySafety(pairAddress, tokenMint),
        liquidityLock(tokenMint),
        walletRate(tokenMint)
      ]);

      const walletHealthy = walletRes[0]?.health === "healthy";

      if (!secPerfect || !secSafety || !liqLocked.locked || !walletHealthy) {
        token.remove = true;
        return;
      }

      // mark initial price & timestamp once
      const scan = await scanedPrice(tokenMint, pairAddress);
      token.entryPrice = scan.priceBNB;
      token.entryTime = now;
      token.deleteTime = now + 10 * 60 * 1000; // 10 min dynamic tracking
      token.candles = [{ open: token.entryPrice, close: token.entryPrice, high: token.entryPrice, low: token.entryPrice, startTime: now }];
      token.staticChecked = true;
      token.lastBNBReserve = scan.bnbReserve;
      return; // wait for dynamic monitoring
    }

    // -------------------- DYNAMIC MONITORING --------------------
const scan = await scanedPrice(tokenMint, pairAddress);
const priceNow = scan.priceBNB;
const rise = (priceNow - token.entryPrice) / token.entryPrice;
const dt = (now - token.entryTime) / 1000;

// Run market health pass dynamically and get pump potential
const marketPass = await marketHealthPass(pairAddress);

// Dynamic risk checks
let velocityTooHigh = false;
let mcapLiquidityBad = false;
let fakeFlowDetected = false;

if (dt > 0 && rise / dt > 0.003) velocityTooHigh = true;
if (scan.marketCap && scan.liquidityBNB && scan.marketCap / scan.liquidityBNB > 25) mcapLiquidityBad = true;
if (token.lastBNBReserve && scan.bnbReserve) {
  const bnbDelta = (scan.bnbReserve - token.lastBNBReserve) / token.lastBNBReserve;
  if (rise > 0.15 && bnbDelta < 0.03) fakeFlowDetected = true;
}

token.lastBNBReserve = scan.bnbReserve;

// -------------------- DYNAMIC MARKET VALIDATION --------------------
if (!marketPass.isHealthy || scan.riskScore >= 4 || velocityTooHigh || mcapLiquidityBad || fakeFlowDetected) {
  console.log(`Token ${tokenMint} failed dynamic health check, removing`);
  token.remove = true;
  return;
}

// You can also log or use pumpPotential for decision-making
console.log(`Token ${tokenMint} pump potential: ${marketPass.pumpPotential}%`);

// -------------------- UPDATE CANDLES --------------------
const candles = token.candles || [];
candles.push({
  open: candles[candles.length - 1].close,
  close: priceNow,
  high: Math.max(priceNow, candles[candles.length - 1].close),
  low: Math.min(priceNow, candles[candles.length - 1].close),
  startTime: now
});
if (candles.length > 3) candles.shift();
token.candles = candles;

// -------------------- REVERSE DETECTION --------------------
if (reverseDetected(candles, rise)) {
  console.log(`Reverse detected for ${tokenMint}, removing`);
  token.remove = true;
  return;
}

// -------------------- TREND PERSISTENCE --------------------
updateTrendPersistence(token, candles);
const REQUIRED_PERSISTENCE = 2;

// -------------------- PUMP POTENTIAL DECISION --------------------
if (token.trendPersistence >= REQUIRED_PERSISTENCE && marketPass.pumpPotential >= 50) {
  console.log(`BUY ${tokenMint} @ ${priceNow} BNB (trend confirmed ${token.trendPersistence}x, pump potential ${marketPass.pumpPotential}%)`);
  const txHash = await autoBuyToken(tokenMint, pairAddress);
  token.bought = true;
  token.remove = true;

  await sendTelegram(
    `BUY CONFIRMED\nToken: ${tokenMint}\nRise: ${(rise * 100).toFixed(2)}%\nPump Potential: ${marketPass.pumpPotential}%\nTx: ${txHash}`
  );
}

// -------------------- BUY CALLER --------------------
export async function buyCaller() {
  const migrators = loadMigrators();
  const tokenPromises = migrators.map(token => rpcQueue.add(() => processToken(token)));
  await Promise.allSettled(tokenPromises);
  saveMigrators(migrators.filter(t => !t.remove));
}

// -------------------- INTERVAL --------------------
setInterval(async () => {
  try {
    await buyCaller();
  } catch (err) {
    console.error("buyCaller error:", err.message);
  }
}, 10_000);