// goplusLiquidityLock.js
import fetch from "node-fetch";

function uniq(arr) {
  return [...new Set(arr)];
}

export async function getGoPlusLiquidityLock({
  chainId = 56,
  pairAddress,
  timeoutMs = 8000
}) {
  if (!pairAddress) {
    return { ok: false, locked: false, reason: "MISSING_PAIR" };
  }

  const url = `https://api.gopluslabs.io/open/api/v1/locks/liquidity?chain_id=${chainId}&address=${pairAddress}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "bnb_Sniper/1.0"
      }
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return { ok: false, locked: false, reason: "HTTP_ERROR" };
    }

    const root = data?.result ?? data?.data ?? null;
    if (!root) {
      return { ok: true, locked: false, evidence: null };
    }

    // Find any array with lock-like objects
    const lockArrays = [];
    (function scan(node) {
      if (!node) return;
      if (Array.isArray(node)) {
        if (node.some((x) => typeof x === "object")) lockArrays.push(node);
        node.forEach(scan);
      } else if (typeof node === "object") {
        Object.values(node).forEach(scan);
      }
    })(root);

    if (lockArrays.length === 0) {
      return { ok: true, locked: false, evidence: null };
    }

    const locks = lockArrays.flat().filter(Boolean);
    if (locks.length === 0) {
      return { ok: true, locked: false, evidence: null };
    }

    const lockers = uniq(
      locks
        .map((x) => x?.locker || x?.platform || x?.provider || x?.name)
        .filter((x) => typeof x === "string")
    );

    return {
      ok: true,
      locked: true,
      source: "goplus",
      evidence: {
        count: locks.length,
        lockers
      }
    };
  } catch {
    return { ok: false, locked: false, reason: "FETCH_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}