// file: goplusLockDuration.js
import fetch from "node-fetch";

function asNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function pickLocks(result, tokenOrLpLower) {
  if (!result) return [];

  const direct =
    result.locks ||
    result.lock_list ||
    result.list ||
    result.items ||
    result.records;

  if (Array.isArray(direct)) return direct;

  const keyed = typeof result === "object" ? result[tokenOrLpLower] : null;
  if (!keyed) return [];

  const nested =
    keyed.locks ||
    keyed.lock_list ||
    keyed.list ||
    keyed.items ||
    keyed.records;

  return Array.isArray(nested) ? nested : [];
}

// Try to extract which locker/platform this lock belongs to.
// GoPlus field names can vary, so we try multiple common keys.
// Return { lockerAddr?: string, lockerName?: string }
function extractLockerMeta(entry) {
  const raw =
    entry?.locker_address ??
    entry?.locker ??
    entry?.lock_contract ??
    entry?.lock_address ??
    entry?.platform_address ??
    entry?.project_address ??
    entry?.contract_address ??
    null;

  const name =
    entry?.locker_name ??
    entry?.platform ??
    entry?.project ??
    entry?.provider ??
    entry?.name ??
    null;

  const lockerAddr =
    typeof raw === "string" && raw.startsWith("0x") && raw.length === 42
      ? raw.toLowerCase()
      : null;

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
      0,
    0
  );
}

function normalizeLocks(lockEntries, knownLockersLowerSet) {
  const now = Math.floor(Date.now() / 1000);

  // Map entries -> { unlockTime, lockerAddr, lockerName }
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
      rawCount: lockEntries.length,
      matchedKnownLocker: false,
      matchedLockers: []
    };
  }

  // If knownLockersLowerSet is provided, filter to those
  const filtered =
    knownLockersLowerSet && knownLockersLowerSet.size > 0
      ? parsed.filter((x) => x.lockerAddr && knownLockersLowerSet.has(x.lockerAddr))
      : parsed;

  const matchedKnownLocker = filtered.length > 0;

  // If we required known lockers and none matched, keep duration as 0
  if (knownLockersLowerSet && knownLockersLowerSet.size > 0 && !matchedKnownLocker) {
    return {
      ok: true,
      hasDuration: false,
      maxLockDuration: 0,
      maxUnlockTime: 0,
      rawCount: lockEntries.length,
      matchedKnownLocker: false,
      matchedLockers: uniq(
        parsed
          .map((x) => x.lockerAddr || x.lockerName)
          .filter(Boolean)
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
      filtered
        .map((x) => x.lockerAddr || x.lockerName)
        .filter(Boolean)
    )
  };
}

/**
 * chainId: 56 for BSC
 * tokenOrLp: you pass LP address (pairAddress)
 * knownLockers: array of locker addresses you trust (optional but recommended)
 */
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