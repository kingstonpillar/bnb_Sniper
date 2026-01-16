// file: test_securityPerfect.js
// Usage:
//   node test_securityPerfect.js
//
// Notes:
// - securityPerfect() enforces allowlist via ./potential_migrators.json
// - If your pair is not inside potential_migrators.json, it will return
//   PAIR_NOT_IN_POTENTIAL_MIGRATORS even if everything else is fine.

import "dotenv/config";
import fs from "fs";
import { ethers } from "ethers";
import { securityPerfect } from "./securityPerfect.js";

const PAIRS = [
  "0x298c4a3ee26f0e9151175a4f4354ea09eeae7628",
  "0xcb540e74cc4100ad6a60d550ca8bbcb365c11549"
];

function norm(a) {
  try {
    return ethers.getAddress(a).toLowerCase();
  } catch {
    return null;
  }
}

function ensureMigratorListHasPairs(pairs, file = "./potential_migrators.json") {
  const want = pairs.map(norm).filter(Boolean);

  let list = [];
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
  }

  const existing = new Set(
    list
      .map((x) => norm(x?.pairaddress))
      .filter(Boolean)
  );

  const missing = want.filter((p) => !existing.has(p));
  if (missing.length === 0) return { ok: true, changed: false, missing: [] };

  // Append minimal entries expected by your allowlist check
  for (const p of missing) list.push({ pairaddress: p });

  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  return { ok: true, changed: true, missing };
}

async function runOne(pair) {
  console.log("\n==============================");
  console.log("PAIR :", pair);

  try {
    const r = await securityPerfect(pair);

    console.log("OK   :", r?.ok ? "YES" : "NO");
    console.log("PASS :", r?.pass ? "YES" : "NO");
    console.log("SCORE:", `${r?.score ?? 0}/${r?.minScore ?? "?"}`);
    console.log("TOKEN:", r?.token || "n/a");
    console.log("REASON:", r?.reason || "n/a");

    if (r?.meta) {
      console.log("META :", {
        name: r.meta.name,
        symbol: r.meta.symbol,
        decimals: r.meta.decimals,
        totalSupply: r.meta.totalSupply
      });
    }

    if (r?.breakdown) {
      console.log("BREAKDOWN:");
      console.log(JSON.stringify(r.breakdown, null, 2));
    } else {
      console.log("RAW:");
      console.log(JSON.stringify(r, null, 2));
    }
  } catch (e) {
    console.log("CRASH:", e?.message || String(e));
  }
}

async function main() {
  // Optional: auto-add pairs to potential_migrators.json so the test actually evaluates
  // Comment this out if you prefer manual control of the allowlist.
  const allow = ensureMigratorListHasPairs(PAIRS);
  if (allow.changed) {
    console.log("Updated potential_migrators.json with missing pairs:", allow.missing);
  }

  // Quick env sanity
  if (!process.env.RPC_READ) console.log("Missing RPC_READ in .env");
  if (!process.env.RPC_LOGS) console.log("Missing RPC_LOGS in .env");

  for (const p of PAIRS) {
    await runOne(p);
  }
}

main();