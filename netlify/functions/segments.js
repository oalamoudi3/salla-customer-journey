/* Netlify Function → reachable at /api/segments via the redirect in netlify.toml.

   FAST PATH: returns the precomputed aggregate written nightly by
   refresh-background.js into Netlify Blobs. No Salla call at request time, so it
   never times out regardless of how many orders a store has.

   Fallbacks:
     • blob not populated yet → sample data (yellow banner), never an error.
     • &debug=1 → a single raw Salla order, for verifying FIELD_MAP (README §4). */
const CONFIG = require("../../config.js");
const { buildSegments } = require("../../lib/salla.js");

const BLOB_STORE = "segments";
const SALLA_BASE = "https://api.salla.dev/admin/v2";

exports.handler = async (event) => {
  try {
    const gate = requireDashKey(event); if (gate) return gate;

    const q = event.queryStringParameters || {};
    const storeKey = q.store || Object.keys(CONFIG.STORES)[0];
    const debug = q.debug === "1";
    const store = CONFIG.STORES[storeKey];
    if (!store) return json(400, { error: "unknown store", stores: Object.keys(CONFIG.STORES) });

    // debug: pull ONE raw order so the field map can be verified quickly (timeout-safe).
    if (debug) {
      const token = process.env[store.tokenEnv] || "";
      if (!token) return json(200, { source: "debug", store: storeKey, note: store.tokenEnv + " not set" });
      const res = await fetch(`${SALLA_BASE}/orders?per_page=1&page=1`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      });
      if (res.status === 401) return json(401, { error: "token rejected", source: "error" });
      const body = await res.json();
      return json(200, {
        source: "debug", store: storeKey,
        totalOrders: body.pagination && body.pagination.total,
        sampleOrder: (body.data && body.data[0]) || null
      });
    }

    // fast path: read the precomputed aggregate from Blobs.
    const { getStore } = await import("@netlify/blobs");
    const blobs = openStore(getStore, BLOB_STORE);
    const precomputed = await blobs.get(storeKey, { type: "json" });
    if (precomputed) {
      return json(200, precomputed, { "Cache-Control": "s-maxage=900, stale-while-revalidate=3600" });
    }

    // not refreshed yet → sample, so the dashboard still renders (with the banner).
    const sample = await buildSegments({ storeKey, token: "", cfg: CONFIG });
    return json(200, sample, { "Cache-Control": "s-maxage=60" });
  } catch (e) {
    const code = e.code === 401 ? 401 : 500;
    return json(code, {
      error: e.code === 401 ? "Salla token rejected (expired or revoked). Refresh it — see README." : String(e.message || e),
      source: "error"
    });
  }
};

/* Auto-config is injected on build-based deploys; manual CLI deploys need explicit
   siteID + token. Use them when present, otherwise fall back to auto. */
function openStore(getStore, name) {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token, consistency: "strong" }) : getStore(name);
}

/* Shared-key gate (see customer.js for rationale). 401 if x-dash-key missing/wrong. */
function requireDashKey(event) {
  const hdr = (event && event.headers) || {};
  const key = hdr["x-dash-key"] || hdr["X-Dash-Key"] || "";
  if (!process.env.DASH_ACCESS_KEY || key !== process.env.DASH_ACCESS_KEY) {
    return json(401, { error: "unauthorized", source: "error" });
  }
  return null;
}

function json(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extra),
    body: JSON.stringify(body)
  };
}
