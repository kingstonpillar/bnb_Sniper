import "dotenv/config";
import fs from "fs";
import { ethers } from "ethers";
import PQueue from "p-queue";
import fetch from "node-fetch";

/* ================= RPC CONFIG ================= */
const RPC_URLS = [
  process.env.RPC_URL_10 || "https://bsc-dataseed1.binance.org/",
  process.env.RPC_URL_20 || "https://bsc-dataseed2.binance.org/",
  process.env.RPC_URL_30 || "https://bnb-mainnet.g.alchemy.com/v2/YOUR_API_KEY",
].filter(Boolean);

if (RPC_URLS.length < 1) throw new Error("❌ At least one RPC_URL_* required");

/* ================= CONSTANTS ================= */
const PANCAKE_FACTORY = ethers.getAddress("0xca143ce32fe78f1f7019d7d551a6402fc5350c73");
const WBNB = ethers.getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");

const OUTPUT_FILE = "./potential_migrators.json";
const MIN_BNB_LIQUIDITY = Number(process.env.MIN_BNB_LIQUIDITY || 24);
const POOL_AGE_THRESHOLD_MS = Number(process.env.POOL_AGE_THRESHOLD_MS || 5 * 60 * 1000);
const MAX_BLOCK_BATCH = Number(process.env.MAX_BLOCK_BATCH || 5);

const PAIR_CREATED_TOPIC = ethers.id("PairCreated(address,address,address,uint256)");
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 15_000);

// ---------------- VALIDATION ----------------
if (!Number.isFinite(SCAN_INTERVAL_MS) || SCAN_INTERVAL_MS <= 0) {
  throw new Error("Invalid SCAN_INTERVAL_MS env value");
}
if (!Number.isFinite(MIN_BNB_LIQUIDITY) || MIN_BNB_LIQUIDITY <= 0) {
  throw new Error("Invalid MIN_BNB_LIQUIDITY env value");
}
if (!Number.isFinite(POOL_AGE_THRESHOLD_MS) || POOL_AGE_THRESHOLD_MS < 0) {
  throw new Error("Invalid POOL_AGE_THRESHOLD_MS env value");
}
if (!Number.isFinite(MAX_BLOCK_BATCH) || MAX_BLOCK_BATCH <= 0) {
  throw new Error("Invalid MAX_BLOCK_BATCH env value");
}

/* ================= TELEGRAM ================= */
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* ================= RPC QUEUE ================= */
const rpcQueue = new PQueue({ interval: 1000, intervalCap: 6 });
let rpcIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

/* ================= FILE LOCK HELPERS (sync) ================= */
function getLockFile(p) {
  return `${p}.lock`;
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function acquireLockSync(p, timeoutMs = 5000) {
  const lock = getLockFile(p);
  const start = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid || 0));
      fs.closeSync(fd);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        // clear stale lock older than 60s
        try {
          const st = fs.statSync(lock);
          if (Date.now() - st.mtimeMs > 60_000) {
            try { fs.unlinkSync(lock); } catch {}
          }
        } catch {}
      }
      sleepSync(25);
    }
  }
}

function releaseLockSync(p) {
  const lock = getLockFile(p);
  try {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {}
}

function safeReadJSONSync(p) {
  acquireLockSync(p);
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } finally {
    releaseLockSync(p);
  }
}

function safeWriteJSONSync(p, data) {
  acquireLockSync(p);
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } finally {
    releaseLockSync(p);
  }
}

/* ================= TELEGRAM ================= */
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.warn("Telegram failed:", err?.message || err);
  }
}

/* ================= RPC FAILOVER ================= */
async function withRpcFailover(fn) {
  let lastError;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await rpcQueue.add(() => fn(provider));
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ RPC failed (${RPC_URLS[rpcIndex]}): ${err?.message || err}`);
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);
      console.log(`➡️ Switched RPC → ${RPC_URLS[rpcIndex]}`);
    }
  }
  throw new Error(`❌ All RPCs failed: ${lastError?.message || lastError}`);
}

/* ================= ON-CHAIN HELPERS ================= */
async function getBNBLiquidity(pairAddress, tokenMint) {
  return withRpcFailover(async (prov) => {
    const PAIR_ABI = [
      "function getReserves() view returns(uint112 reserve0, uint112 reserve1, uint32)",
      "function token0() view returns(address)",
      "function token1() view returns(address)",
    ];
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, prov);
    const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
    const bnbReserve =
      token0.toLowerCase() === tokenMint.toLowerCase() ? reserves.reserve1 : reserves.reserve0;
    return Number(ethers.formatUnits(bnbReserve, 18));
  });
}

async function getTokenInfo(tokenAddress) {
  return withRpcFailover(async (prov) => {
    const ERC20_ABI = [
      "function symbol() view returns(string)",
      "function name() view returns(string)",
    ];
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, prov);
      const [symbol, name] = await Promise.all([token.symbol(), token.name()]);
      return { symbol, name };
    } catch {
      return { symbol: null, name: null };
    }
  });
}

/* ================= SAVE PAIR (LOCKED) ================= */
function savePair(entry) {
  const now = Date.now();
  if (now - entry.detectedat > POOL_AGE_THRESHOLD_MS) return;

  try {
    entry.tokenmint = ethers.getAddress(entry.tokenmint);
    entry.pairaddress = ethers.getAddress(entry.pairaddress);
  } catch {
    return;
  }

  const data = safeReadJSONSync(OUTPUT_FILE);

  const exists = data.some(
    (p) => String(p.pairaddress || "").toLowerCase() === entry.pairaddress.toLowerCase()
  );
  if (exists) return;

  data.push(entry);
  safeWriteJSONSync(OUTPUT_FILE, data);

  console.log("✅ New token detected:", entry.tokenSymbol || entry.tokenmint);

  void sendTelegram(
    `🚀 *NEW TOKEN DETECTED*\nToken: ${entry.tokenSymbol || entry.tokenmint}\nName: ${entry.tokenName || "N/A"}\nPair: ${entry.pairaddress}\nLiquidity: ${entry.bnbLiquidity} BNB\nBlock: ${entry.blocknumber}`
  );
}

/* ================= STATE (LAZY INIT) ================= */
let lastBlock = null;

/* ================= MAIN SCAN ================= */
async function scan() {
  if (lastBlock == null) {
    lastBlock = await withRpcFailover((p) => p.getBlockNumber());
    console.log("[newListingAlert] Starting from block:", lastBlock);
    return; // start scanning from next tick
  }

  const currentBlock = await withRpcFailover((p) => p.getBlockNumber());
  if (currentBlock <= lastBlock) return;

  const existingPairs = safeReadJSONSync(OUTPUT_FILE).map((p) =>
    String(p.pairaddress || "").toLowerCase()
  );

  for (let from = lastBlock + 1; from <= currentBlock; from += MAX_BLOCK_BATCH) {
    const to = Math.min(from + MAX_BLOCK_BATCH - 1, currentBlock);

    const logs = await withRpcFailover((p) =>
      p.getLogs({
        address: PANCAKE_FACTORY,
        fromBlock: from,
        toBlock: to,
        topics: [PAIR_CREATED_TOPIC],
      })
    );

    for (const log of logs) {
      const token0 = ethers.getAddress("0x" + log.topics[1].slice(26));
      const token1 = ethers.getAddress("0x" + log.topics[2].slice(26));
      const pair = ethers.getAddress("0x" + log.data.slice(26, 66));

      if (existingPairs.includes(pair.toLowerCase())) continue;

      let tokenMint = null;
      if (token0 === WBNB) tokenMint = token1;
      else if (token1 === WBNB) tokenMint = token0;
      else continue;

      const bnbLiquidity = await getBNBLiquidity(pair, tokenMint);
      if (bnbLiquidity < MIN_BNB_LIQUIDITY) continue;

      const tokenInfo = await getTokenInfo(tokenMint);

      savePair({
        tokenmint: tokenMint,
        pairaddress: pair,
        blocknumber: log.blockNumber,
        detectedat: Date.now(),
        bnbLiquidity,
        tokenSymbol: tokenInfo.symbol,
        tokenName: tokenInfo.name,
      });
    }
  }

  lastBlock = currentBlock;
}

/* ================= ENGINE (START / STOP) ================= */
let scanTimer = null;
let scanRunning = false;

export async function newListingAlert() {
  await scan();
}

async function runScanTick(label) {
  if (scanRunning) return;
  scanRunning = true;
  try {
    await newListingAlert();
  } catch (err) {
    console.error(`[newListingAlert] ${label} error:`, err?.message || err);
  } finally {
    scanRunning = false;
  }
}

export function startNewListingAlert() {
  if (scanTimer) return;

  void runScanTick("initial tick");

  scanTimer = setInterval(() => {
    void runScanTick("loop tick");
  }, SCAN_INTERVAL_MS);

  console.log("[newListingAlert] started", { SCAN_INTERVAL_MS });
}

export async function stopNewListingAlert() {
  if (!scanTimer) return;

  clearInterval(scanTimer);
  scanTimer = null;

  while (scanRunning) {
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("[newListingAlert] stopped");
}