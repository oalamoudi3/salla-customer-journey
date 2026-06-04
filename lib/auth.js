/* =============================================================================
   auth.js — Node-only. Salla OAuth token custody for the functions.

   WHY THIS EXISTS: Salla access tokens expire (~2 weeks). Without refresh the
   nightly pull eventually 401s and the dashboard silently falls back to sample
   data. This module refreshes the access token using the refresh token.

   SALLA REFRESH RULE (do not "simplify" away): refresh tokens are SINGLE-USE —
   each refresh returns a NEW refresh token and invalidates the old one. Two
   refreshes of the same token in parallel = full auth wipe + forced reinstall.
   Therefore:
     • refreshIfNeeded() runs in EXACTLY ONE place — the single nightly background
       function (refresh-background). It is the only writer of the "auth" blob.
     • request-path functions (segments, customer) use readAccessToken() — READ
       ONLY, never refresh.
     • the new refresh_token is persisted to Blobs immediately, before it is used.

   Token state lives in Blobs store "auth", key = storeKey:
       { access_token, refresh_token, expires_at, refreshedAt }
   It is seeded on first run from env (see env var names below).
   ============================================================================= */

const OAUTH_URL = "https://accounts.salla.sa/oauth2/token"; // form-urlencoded, NOT JSON
const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;               // refresh when <24h to expiry
const LOCK_MS = 90 * 1000;                                 // soft single-flight window

/* env var names for a store (per-store, with shared fallback for client creds) */
function envNames(storeKey, cfg) {
  const store = (cfg.STORES || {})[storeKey] || {};
  return {
    accessSeed: store.tokenEnv || ("SALLA_TOKEN_" + storeKey),
    refreshSeed: "SALLA_REFRESH_TOKEN_" + storeKey,
    clientId: process.env["SALLA_CLIENT_ID_" + storeKey] || process.env.SALLA_CLIENT_ID || "",
    clientSecret: process.env["SALLA_CLIENT_SECRET_" + storeKey] || process.env.SALLA_CLIENT_SECRET || ""
  };
}

/* current record from Blobs, seeded from env on first run (seed is NOT written here) */
async function readRecord(blobs, storeKey, cfg) {
  const env = envNames(storeKey, cfg);
  const rec = (await blobs.get(storeKey, { type: "json" })) || {};
  return {
    access_token: rec.access_token || process.env[env.accessSeed] || "",
    refresh_token: rec.refresh_token || process.env[env.refreshSeed] || "",
    expires_at: rec.expires_at || 0,
    refreshedAt: rec.refreshedAt || 0,
    lockedAt: rec.lockedAt || 0
  };
}

/* READ-ONLY access token for request-path functions. Never refreshes. */
async function readAccessToken(blobs, storeKey, cfg) {
  const rec = await readRecord(blobs, storeKey, cfg);
  return rec.access_token || "";
}

/* perform the form-urlencoded refresh; returns the parsed token payload or throws */
async function doRefresh(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  if (!res.ok) { const e = new Error("Salla token refresh " + res.status); e.code = res.status; throw e; }
  const j = await res.json();
  if (!j.access_token) throw new Error("refresh response missing access_token");
  return j;
}

/* BACKGROUND-ONLY. Ensure a fresh access token for storeKey, persisting any newly
   issued tokens to Blobs immediately. Returns the usable access_token (possibly the
   existing one if refresh wasn't needed or wasn't possible). Returns "" only when no
   token of any kind is available. */
async function refreshIfNeeded(blobs, storeKey, cfg) {
  const env = envNames(storeKey, cfg);
  const rec = await readRecord(blobs, storeKey, cfg);

  const needs = !rec.access_token || !rec.expires_at || rec.expires_at < (Date.now() + REFRESH_SKEW_MS);
  const canRefresh = rec.refresh_token && env.clientId && env.clientSecret;

  if (needs && canRefresh) {
    // Soft single-flight guard. The REAL guarantee against single-use refresh
    // collisions is that this runs in one scheduled background instance; this lock
    // just narrows the window if two invocations overlap.
    if (rec.lockedAt && Date.now() - rec.lockedAt < LOCK_MS) {
      return rec.access_token; // another invocation is (probably) refreshing
    }
    await blobs.setJSON(storeKey, { ...rec, lockedAt: Date.now() });
    try {
      const j = await doRefresh(rec.refresh_token, env.clientId, env.clientSecret);
      rec.access_token = j.access_token;
      if (j.refresh_token) rec.refresh_token = j.refresh_token; // single-use → keep the new one
      rec.expires_at = Date.now() + (Number(j.expires_in) || 0) * 1000;
      rec.refreshedAt = Date.now();
      rec.lockedAt = 0;
      await blobs.setJSON(storeKey, rec); // persist BEFORE the token is used
      return rec.access_token;
    } catch (e) {
      // Refresh failed — release the lock, keep using the existing access token
      // (it may still be valid; if not, the pull will 401 and surface clearly).
      await blobs.setJSON(storeKey, { ...rec, lockedAt: 0 });
      return rec.access_token || "";
    }
  }

  // No refresh happened. When we CAN'T refresh (no client creds yet), the env var
  // SALLA_TOKEN_<STORE> is the operator's manual-rotation channel: if it now differs
  // from the stored token, adopt it (so swapping the env var + redeploy takes effect).
  // When creds DO exist, the blob is authoritative (auto-refresh maintains it) and we
  // never clobber a freshly refreshed token with a stale env seed.
  const envAccess = process.env[env.accessSeed] || "";
  if (!canRefresh && envAccess && envAccess !== rec.access_token) {
    rec.access_token = envAccess; rec.expires_at = 0; rec.refreshedAt = 0;
    await blobs.setJSON(storeKey, { access_token: rec.access_token, refresh_token: rec.refresh_token, expires_at: 0, refreshedAt: 0, lockedAt: 0 });
  } else if (!rec.refreshedAt) {
    await blobs.setJSON(storeKey, { ...rec, lockedAt: 0 });
  }
  return rec.access_token || "";
}

module.exports = { readAccessToken, refreshIfNeeded, OAUTH_URL };
