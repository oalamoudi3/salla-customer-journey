/* Netlify Function → /api/journey  (#4 cross-store customer journey)
   Reads the precomputed "journey" blob written by refresh-background.js (cross-store
   aggregate: stage funnel + next-stage recommendations, matched via hashed mobile).
   No PII — only aggregate counts. Gated by the shared dashboard key like the others. */
const CONFIG = require("../../config.js");

const BLOB_STORE = "segments";

exports.handler = async (event) => {
  try {
    const gate = requireDashKey(event); if (gate) return gate;
    const { getStore } = await import("@netlify/blobs");
    const blobs = openStore(getStore, BLOB_STORE);
    const journey = await blobs.get("journey", { type: "json" });
    if (!journey) return json(200, { found: false, note: "no journey yet — run the nightly refresh" });
    return json(200, Object.assign({ found: true }, journey), { "Cache-Control": "private, no-store" });
  } catch (e) {
    const code = e.code === 401 ? 401 : 500;
    return json(code, { error: String(e.message || e), source: "error" });
  }
};

function openStore(getStore, name) {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token, consistency: "strong" }) : getStore(name);
}

/* Shared-key gate. 401 if x-dash-key missing/wrong. */
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
