/* =============================================================================
   refresh-background.js — Netlify BACKGROUND function (filename ends in
   "-background", so it gets the ~15-minute execution budget instead of the 10s
   synchronous limit). It returns 202 to the caller immediately and keeps running.

   What it does: for every store, pulls ALL orders from Salla, computes the
   RFM/lifecycle aggregate (via buildSegments), and writes the result JSON to a
   Netlify Blobs store. The fast /api/segments endpoint then just reads that blob
   — no Salla call, no timeout, full dataset.

   Triggered nightly by refresh-scheduled.js, or manually:
     curl -X POST https://<site>/.netlify/functions/refresh-background
   ============================================================================= */
const CONFIG = require("../../config.js");
const { buildSegments, computeJourney } = require("../../lib/salla.js");
const auth = require("../../lib/auth.js");

const BLOB_STORE = "segments";
const AUTH_STORE = "auth";

async function refreshStore(blobs, blobsAuth, storeKey) {
  const store = CONFIG.STORES[storeKey];
  // The ONLY place tokens are refreshed (single-use refresh → single writer). Reads
  // the auth blob, refreshes + persists if near expiry, returns a usable access token.
  let token = "";
  try { token = await auth.refreshIfNeeded(blobsAuth, storeKey, CONFIG); }
  catch (e) { return { storeKey, ok: false, reason: "auth: " + String((e && e.message) || e) }; }
  if (!token) return { storeKey, ok: false, reason: "no token (seed " + store.tokenEnv + " / refresh creds missing)" };
  try {
    const data = await buildSegments({ storeKey, token, cfg: CONFIG });
    // separate the full scored list from the aggregate the dashboard reads every load.
    const all = data.allCustomers || [];
    delete data.allCustomers;
    await blobs.setJSON(storeKey, data);
    // searchable index: every customer (id, name, orders, revenue, recency, R/F/M, segment, tier).
    await blobs.setJSON("index_" + storeKey, {
      generatedAt: data.generatedAt,
      customers: all.map(c => ({
        id: c.id, name: c.name, orders: c.orders, revenue: c.revenue, recencyDays: c.recencyDays,
        R: c.R, F: c.F, M: c.M, segment: c.segment, tier: c.tier, customerType: c.customerType
      }))
    });
    // #4 — collect this store's cross-store hash keys (mobile hashes) for the journey join.
    const hashes = all.map(c => c.hashKey).filter(Boolean);
    return { storeKey, ok: true, source: data.source, ordersScanned: data.ordersScanned, total: data.total, hashes };
  } catch (e) {
    return { storeKey, ok: false, reason: String((e && e.message) || e), code: e && e.code };
  }
}

/* Auto-config is injected on build-based deploys; manual CLI deploys need explicit
   siteID + token. Use them when present, otherwise fall back to auto. */
function openStore(getStore, name) {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token, consistency: "strong" }) : getStore(name);
}

exports.handler = async (event) => {
  // Gate: only callers with the refresh key may trigger a pull (refresh-scheduled
  // forwards it). NOTE: background functions ack 202 to the caller immediately, so
  // this early return simply prevents unauthorized work — it won't reach the caller.
  const hdr = (event && event.headers) || {};
  const key = hdr["x-refresh-key"] || hdr["X-Refresh-Key"] || "";
  if (!process.env.REFRESH_KEY || key !== process.env.REFRESH_KEY) {
    return { statusCode: 401, body: "unauthorized" };
  }

  const { getStore } = await import("@netlify/blobs");
  const blobs = openStore(getStore, BLOB_STORE);
  const blobsAuth = openStore(getStore, AUTH_STORE);

  // Optional ?store=KEY refreshes just one store (handy after a token swap or a
  // rate-limit failure, so we don't re-pull the others).
  const only = (event && event.queryStringParameters && event.queryStringParameters.store) || "";
  const keys = (only && CONFIG.STORES[only]) ? [only] : Object.keys(CONFIG.STORES);

  // In parallel — wall time ≈ the slowest store, well under the 15-min budget.
  // Safe for single-use refresh because each store refreshes its OWN token once.
  const results = await Promise.all(keys.map((k) => refreshStore(blobs, blobsAuth, k)));

  // #4 — cross-store journey: only recompute on a FULL refresh that covered every store in
  // CROSS_JOURNEY.order (a single-store refresh can't see the others' hashes). Non-critical.
  try {
    const storeHashes = {};
    results.forEach((r) => { if (r.ok && r.hashes) storeHashes[r.storeKey] = new Set(r.hashes); });
    const order = (CONFIG.CROSS_JOURNEY || {}).order || [];
    if (order.length && order.every((k) => storeHashes[k])) {
      await blobs.setJSON("journey", computeJourney(storeHashes, CONFIG));
    }
  } catch (e) { /* journey is non-critical — never fail the refresh over it */ }

  // strip the (large) hash arrays before recording the run summary.
  results.forEach((r) => { delete r.hashes; });
  await blobs.setJSON("_meta", { refreshedAt: Date.now(), results });

  return { statusCode: 200, body: JSON.stringify({ refreshedAt: Date.now(), results }) };
};
