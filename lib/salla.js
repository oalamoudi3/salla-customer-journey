/* =============================================================================
   salla.js — Node-only. Pulls orders from Salla, rolls them up per customer,
   then hands off to segmentation.js for scoring. Used by the serverless function.
   ============================================================================= */
const SEG = require("./segmentation.js");

const SALLA_BASE = "https://api.salla.dev/admin/v2";

/* read "a.b.c" out of an object, safely */
function path(obj, p) {
  if (!p) return undefined;
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
/* try the configured path, then each fallback */
function readField(order, spec) {
  let v = path(order, spec.path);
  if (v == null) for (const f of (spec.fallback || [])) { v = path(order, f); if (v != null) break; }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* fetch one orders page with 429-aware retry (honours Retry-After, else backs off). */
async function fetchOrdersPage(token, page, perPage) {
  const url = `${SALLA_BASE}/orders?per_page=${perPage}&page=${page}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401) { const e = new Error("UNAUTHORIZED"); e.code = 401; throw e; }
    if (res.status === 429) {
      if (attempt >= 6) { const e = new Error("Salla 429 (rate limited after retries)"); e.code = 429; throw e; }
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 20000));
      continue;
    }
    if (!res.ok) { const e = new Error(`Salla ${res.status}`); e.code = res.status; throw e; }
    return res.json();
  }
}

async function fetchAllOrders(token, cfg) {
  const { perPage, maxPages } = cfg.PULL;
  let page = 1, totalPages = 1, all = [], capped = false;
  do {
    const json = await fetchOrdersPage(token, page, perPage);
    all = all.concat(json.data || []);
    totalPages = (json.pagination && json.pagination.totalPages) || 1; // camelCase, per Salla
    if (page >= maxPages && totalPages > maxPages) { capped = true; break; }
    page++;
    if (page <= totalPages) await sleep(150); // gentle pacing to stay under Salla's rate limit
  } while (page <= totalPages);
  return { orders: all, capped, totalPages };
}

/* orders → one record per customer with recency/frequency/monetary */
function rollup(orders, cfg) {
  const now = Date.now();
  const cutoff = now - cfg.PULL.lookbackDays * 864e5;
  const excl = new Set(cfg.EXCLUDED_STATUS_SLUGS || []);
  const byCust = {};
  for (const o of orders) {
    const slug = readField(o, cfg.FIELD_MAP.statusSlug);
    if (excl.has(slug)) continue;
    const cid = readField(o, cfg.FIELD_MAP.customerId);
    if (cid == null) continue;
    const created = new Date(readField(o, cfg.FIELD_MAP.createdAt));
    const t = created.getTime();
    if (isNaN(t) || t < cutoff) continue;
    let amount = Number(readField(o, cfg.FIELD_MAP.total)) || 0;
    const first = readField(o, cfg.FIELD_MAP.customerFirst) || "";
    const last = readField(o, cfg.FIELD_MAP.customerLast) || "";
    const name = (first + " " + last).trim() || `#${cid}`;
    const c = byCust[cid] || (byCust[cid] = { id: cid, name, orders: 0, revenue: 0, last: 0, first: Infinity });
    c.orders++; c.revenue += amount;
    if (t > c.last) c.last = t;
    if (t < c.first) c.first = t;
    if ((c.name || "").startsWith("#") && !name.startsWith("#")) c.name = name;
  }
  return Object.values(byCust).map(c => ({
    id: c.id, name: c.name, orders: c.orders, revenue: Math.round(c.revenue),
    recencyDays: Math.floor((now - c.last) / 864e5),
    firstOrderDays: Math.floor((now - c.first) / 864e5)
  }));
}

/* main entry. token falsy → demo mode. debug → returns one raw order. */
async function buildSegments({ storeKey, token, cfg, debug }) {
  const meta = { store: storeKey, generatedAt: Date.now() };
  if (!token) {
    const custs = SEG.scoreStore(SEG.genSampleCustomers(storeKey, cfg), cfg, storeKey);
    return Object.assign({ source: "sample" }, meta, SEG.aggregate(custs, cfg, storeKey));
  }
  const { orders, capped, totalPages } = await fetchAllOrders(token, cfg);
  if (debug) return { source: "debug", store: storeKey, ordersFetched: orders.length, totalPages, sampleOrder: orders[0] || null };
  const custs = SEG.scoreStore(rollup(orders, cfg), cfg, storeKey);
  const out = Object.assign({ source: "live", ordersScanned: orders.length, capped }, meta, SEG.aggregate(custs, cfg, storeKey));
  // full scored list (ALL customers, not just the top-100 in the aggregate) so the
  // refresh can persist a searchable index. Non-enumerable-ish: callers that send the
  // aggregate to the browser must strip this first (see refresh-background.js).
  out.allCustomers = custs;
  return out;
}

module.exports = { buildSegments };
