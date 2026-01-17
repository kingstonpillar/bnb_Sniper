// file: goplusLockDuration.js
import fetch from "node-fetch";

function asNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function normAddr(a) {
  if (typeof a !== "string") return null;
  if (!a.startsWith("0x") || a.length !== 42) return null;
  return a.toLowerCase();
}

// Find an object entry by matching keys case-insensitively
function pickByAddressKey(obj, addrLower) {
  if (!obj || typeof obj !== "object") return null;
  if (obj[addrLower]) return obj[addrLower];

  // Scan keys (checksum vs lowercase)
  const keys = Object.keys(obj);
  const hit = keys.find((k) => String(k).toLowerCase() === addrLower);
  return hit ? obj[hit] : null;
}

function pickLocks(result, tokenOrLpLower) {
  if (!result) return [];

  // Sometimes it is already an array
  if (Array.isArray(result)) return result;

  // Common direct list locations
  const direct =
    result.locks ||
    result.lock_list ||
    result.lockList ||
    result.list ||
    result.items ||
    result.records ||
    result.data ||
    null;

  if (Array.isArray(direct)) return direct;

  // If "data" is an object that contains the address key
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const keyedFromData = pickByAddressKey(direct, tokenOrLpLower);
    if (keyedFromData) {
      const nested =
        keyedFromData.locks ||
        keyedFromData.lock_list ||
        keyedFromData.lockList ||
        keyedFromData.list ||
        keyedFromData.items ||
        keyedFromData.records;
      return Array.isArray(nested) ? nested : [];
    }
  }

  // Address-keyed object at the top level
  const keyed = pickByAddressKey(result, tokenOrLpLower);
  if (!keyed) return [];

  const nested =
    keyed.locks ||
    keyed.lock_list ||
    keyed.lockList ||
    keyed.list ||
    keyed.items ||
    keyed.records;

  return Array.isArray(nested) ? nested : [];
}

function extractLockerMeta(entry) {
  const raw =
    entry?.locker_address ??
    entry?.locker ??
    entry?.lock_contract ??
    entry?.lock_address ??
    entry?.platform_address ??
    entry?.project_address ??
    entry?.contract_address ??
    entry?.lock_contract_address ??
    entry?.provider_address ??
    null;

  const name =
    entry?.locker_name ??
    entry?.platform ??
    entry?.project ??
    entry?.provider ??
    entry?.name ??
    entry?.locker ??
    null;

  const lockerAddr = normAddr(raw);
  const lockerName = typeof name === "string" ? name : null;

  return { lockerAddr, lockerName };
}

function extractUnlockTime(entry) {
  return asNum(
    entry?.unlock_time ??
      entry?.unlockTime ??
      entry?.unlock_at ??
      entry?.end_time ??
      entry?.expiration ??
      entry?.unlockTimestamp ??
      0,
    0
  );
}

function lockerNameMatchesKnown(lockerName, knownNameKeywordsLower) {
  if (!lockerName) return false;
  const s = lockerName.toLowerCase();
  return knownNameKeywordsLower.some((k) => s.includes(k));
}

function normalizeLocks(lockEntries, knownLockersLowerSet) {
  const now = Math.floor(Date.now() / 1000);

  const knownNameKeywordsLower = [
    "pinksale",
    "pinklock",
    "unicrypt",
    "team finance",
    "teamfinance",
    "dxsale",
    "dxlocker"
  ];

  const parsed = lockEntries
    .map((x) => {
      const unlockTime = extractUnlockTime(x);
      const { lockerAddr, lockerName } = extractLockerMeta(x);
      return { unlockTime, lockerAddr, lockerName };
    })
    .filter((x) => x.unlockTime > 0);

  if (parsed.length === 0) {
    return {
      ok: true,
      hasDuration: false,
      maxLockDuration: 0,
      maxUnlockTime: 0,
      rawCount: Array.isArray(lockEntries) ? lockEntries.length : 0,
      matchedKnownLocker: false,
      matchedLockers: []
    };
  }

  // Filter to known lockers.
  // Match by address OR by known locker name keywords when address is missing.
  const filtered =
    knownLockersLowerSet && knownLockersLowerSet.size > 0
      ? parsed.filter(
          (x) =>
            (x.lockerAddr && knownLockersLowerSet.has(x.lockerAddr)) ||
            (!x.lockerAddr && lockerNameMatchesKnown(x.lockerName, knownNameKeywordsLower))
        )
      : parsed;

  const matchedKnownLocker = filtered.length > 0;

  // If you supplied known lockers and none matched, treat as no duration for gating purposes
  if (knownLockersLowerSet && knownLockersLowerSet.size > 0 && !matchedKnownLocker) {
    return {
      ok: true,
      hasDuration: false,
      maxLockDuration: 0,
      maxUnlockTime: 0,
      rawCount: lockEntries.length,
      matchedKnownLocker: false,
      matchedLockers: uniq(
        parsed.map((x) => x.lockerAddr || x.lockerName).filter(Boolean)
      )
    };
  }

  const unlockTimes = filtered.map((x) => x.unlockTime);
  const maxUnlockTime = Math.max(...unlockTimes);
  const maxLockDuration = Math.max(0, maxUnlockTime - now);

  return {
    ok: true,
    hasDuration: true,
    maxLockDuration,
    maxUnlockTime,
    rawCount: lockEntries.length,
    matchedKnownLocker,
    matchedLockers: uniq(
      filtered.map((x) => x.lockerAddr || x.lockerName).filter(Boolean)
    )
  };
}

export async function getGoPlusLockDuration({
  chainId = 56,
  tokenOrLp,
  knownLockers = [],
  timeoutMs = 8000
}) {
  if (!tokenOrLp) return { ok: false, reason: "MISSING_TOKEN_OR_LP" };

  const tokenOrLpLower = String(tokenOrLp).toLowerCase();
  const knownSet = new Set((knownLockers || []).map((x) => String(x).toLowerCase()));

  const candidates = uniq([
    `https://api.gopluslabs.io/open/api/v1/locks/token?chain_id=${chainId}&address=${tokenOrLp}`,
    `https://api.gopluslabs.io/open/api/v1/locks/liquidity?chain_id=${chainId}&address=${tokenOrLp}`
  ]);

  let lastErr = null;

  for (const url of candidates) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }

      const result = data?.result ?? data?.data ?? data;
      const locks = pickLocks(result, tokenOrLpLower);

      if (!Array.isArray(locks) || locks.length === 0) continue;

      return normalizeLocks(locks, knownSet);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    ok: false,
    reason: "NO_LOCK_DATA",
    error: lastErr?.message || String(lastErr)
  };
}