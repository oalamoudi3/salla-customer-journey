/* Netlify Function → /api/customer  (customer search/lookup)
   Reads the precomputed full-customer INDEX from Blobs (written nightly by
   refresh-background.js), so RFM/segment come from real computed data and the
   lookup is instant for ANY customer — not just the top 100 shown in the table.

   Query params:
     store : store key (required)
     id    : exact customer id  → returns that customer + live contact info from Salla
     q     : name/id fragment    → returns up to 25 matching customers (no contact lookup)
*/
const CONFIG = require("../../config.js");
const auth = require("../../lib/auth.js");

const BLOB_STORE = "segments";
const AUTH_STORE = "auth";
const SALLA_BASE = "https://api.salla.dev/admin/v2";

exports.handler = async (event) => {
  try {
    const gate = requireDashKey(event); if (gate) return gate;

    const p = event.queryStringParameters || {};
    const storeKey = p.store || Object.keys(CONFIG.STORES)[0];
    const store = CONFIG.STORES[storeKey];
    if (!store) return json(400, { error: "unknown store" });
    const id = (p.id || "").trim();
    const q = (p.q || "").trim().toLowerCase();
    if (!id && !q) return json(400, { error: "provide id or q" });

    const { getStore } = await import("@netlify/blobs");
    const blobs = openStore(getStore, BLOB_STORE);
    const index = await blobs.get("index_" + storeKey, { type: "json" });
    if (!index || !index.customers) {
      return json(200, { found: false, store: storeKey, note: "no index yet — run the nightly refresh first" });
    }

    // exact id lookup → enrich with live contact info
    if (id) {
      const c = index.customers.find(x => String(x.id) === id);
      if (!c) return json(200, { found: false, store: storeKey, id });
      // READ-ONLY token (never refresh in a request-path function); degrade to null contact.
      const token = await auth.readAccessToken(openStore(getStore, AUTH_STORE), storeKey, CONFIG);
      const contact = await fetchContact(token, id);
      return json(200, { found: true, store: storeKey, customer: c, contact });
    }

    // name / id fragment search (no contact lookup; keep it cheap)
    const matches = index.customers
      .filter(c => String(c.id).includes(q) || (c.name || "").toLowerCase().includes(q))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 25);
    return json(200, { found: matches.length > 0, store: storeKey, count: matches.length, matches });
  } catch (e) {
    const code = e.code === 401 ? 401 : 500;
    return json(code, { error: String(e.message || e), source: "error" });
  }
};

async function fetchContact(token, id) {
  if (!token) return null;
  try {
    const res = await fetch(`${SALLA_BASE}/customers/${id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!res.ok) return null;
    const d = (await res.json()).data || {};
    return {
      email: d.email || "",
      mobile: d.mobile ? `${d.mobile_code || ""}${d.mobile}` : "",
      city: (d.city && (d.city.name || d.city)) || "",
      adminUrl: (d.urls || {}).admin || ""
    };
  } catch { return null; }
}

function openStore(getStore, name) {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token, consistency: "strong" }) : getStore(name);
}

/* Shared-key gate. Returns a 401 response if the x-dash-key header is missing/wrong,
   else null. The server-side check is the real protection (this endpoint returns PII);
   the browser passphrase prompt is just UX. Alternative zero-code option: enable
   Netlify password protection / Identity on the site. */
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
