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
    // B2B signal (Phase 2): a valid Saudi VAT or a company name on the order. Guarded so
    // it's a no-op if these FIELD_MAP paths aren't configured. Paths UNCONFIRMED — verify
    // via ?debug=1 (see config.FIELD_MAP.vatNumber / .company).
    const vat = cfg.FIELD_MAP.vatNumber ? readField(o, cfg.FIELD_MAP.vatNumber) : null;
    const company = cfg.FIELD_MAP.company ? readField(o, cfg.FIELD_MAP.company) : null;
    const b2b = SEG.validVat(vat) || (company != null && String(company).trim() !== "");
    const c = byCust[cid] || (byCust[cid] = { id: cid, name, orders: 0, revenue: 0, last: 0, first: Infinity, b2bSignal: false });
    c.orders++; c.revenue += amount;
    if (b2b) c.b2bSignal = true; // B2B if ANY of the customer's orders qualifies
    if (t > c.last) c.last = t;
    if (t < c.first) c.first = t;
    if ((c.name || "").startsWith("#") && !name.startsWith("#")) c.name = name;
  }
  return Object.values(byCust).map(c => ({
    id: c.id, name: c.name, orders: c.orders, revenue: Math.round(c.revenue),
    recencyDays: Math.floor((now - c.last) / 864e5),
    firstOrderDays: Math.floor((now - c.first) / 864e5),
    b2bSignal: c.b2bSignal
  }));
}

/* period keys in UTC for an epoch ms. month "YYYY-MM", quarter "YYYY-Qn", year "YYYY". */
function periodKeys(t) {
  const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth(); // m: 0–11
  return {
    month:   y + "-" + String(m + 1).padStart(2, "0"),
    quarter: y + "-Q" + (Math.floor(m / 3) + 1),
    year:    String(y)
  };
}

/* Generic bucketer: roll the prepared order events into one series at the chosen
   granularity, plus a per-period geo breakdown. Unique counts (buyers, geo customers)
   are computed with Sets PER BUCKET, so they stay correct at every granularity — this
   is why quarter/year are built on the server, not summed in the browser (summing
   monthly uniques would double-count repeat buyers). keepLast trims to the trailing N
   periods (used for months); null keeps all (quarters/years). */
function buildSeries(valid, firstByCust, keyOf, keepLast, topCities) {
  const periods = {}, geoByPeriod = {}, newByPeriod = {};
  for (const cid in firstByCust) { const k = keyOf(firstByCust[cid]); newByPeriod[k] = (newByPeriod[k] || 0) + 1; }
  for (const v of valid) {
    const k = keyOf(v.t);
    const p = periods[k] || (periods[k] = { period: k, revenue: 0, orders: 0, _buyers: new Set() });
    p.revenue += v.amt; p.orders++; p._buyers.add(v.cid);
    const g = geoByPeriod[k] || (geoByPeriod[k] = {});
    const ck = v.city || "0"; // placeholder for "unknown", relabelled in UI
    const gc = g[ck] || (g[ck] = { city: v.city, revenue: 0, orders: 0, _cust: new Set() });
    gc.revenue += v.amt; gc.orders++; gc._cust.add(v.cid);
  }
  let series = Object.values(periods)
    .map(p => ({ period: p.period, revenue: Math.round(p.revenue), orders: p.orders, buyers: p._buyers.size,
                 aov: p.orders ? Math.round(p.revenue / p.orders) : 0, newCustomers: newByPeriod[p.period] || 0 }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
  if (keepLast) series = series.slice(-keepLast);
  const keep = new Set(series.map(s => s.period));
  const geo = {};
  for (const k in geoByPeriod) {
    if (keepLast && !keep.has(k)) continue;
    geo[k] = Object.values(geoByPeriod[k])
      .map(g => ({ city: g.city, revenue: Math.round(g.revenue), orders: g.orders, customers: g._cust.size }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, topCities);
  }
  return { series, geo };
}

/* orders → time-bucketed trend series (month/quarter/year) + per-period and all-time
   geo. Order-based metrics only (sales, orders, AOV, new customers, unique buyers) —
   these CAN be bucketed by period, unlike the RFM snapshot. New customers per period =
   customers whose first order (in the pulled window) falls in that period.
   Output shape:
     { monthly, geo,                       // backward-compatible (monthly + all-time geo)
       periods: { month:{series,geo}, quarter:{…}, year:{…} } }  // geo keyed by period */
function timeSeries(orders, cfg) {
  const FM = cfg.FIELD_MAP, excl = new Set(cfg.EXCLUDED_STATUS_SLUGS || []);
  const now = Date.now(), cutoff = now - cfg.PULL.lookbackDays * 864e5;
  const firstByCust = {}, valid = [];
  for (const o of orders) {
    if (excl.has(readField(o, FM.statusSlug))) continue;
    const cid = readField(o, FM.customerId); if (cid == null) continue;
    const t = new Date(readField(o, FM.createdAt)).getTime();
    if (isNaN(t) || t < cutoff) continue;
    const amt = Number(readField(o, FM.total)) || 0;
    let city = readField(o, FM.shipCity);
    if (city && typeof city === "object") city = city.name || city.city || "";
    city = (city == null ? "" : String(city)).trim();
    valid.push({ t, cid, amt, city });
    if (firstByCust[cid] == null || t < firstByCust[cid]) firstByCust[cid] = t;
  }
  const topCities = cfg.PULL.geoTopCities || 20;
  const month   = buildSeries(valid, firstByCust, t => periodKeys(t).month, cfg.PULL.monthlyMonths || 13, topCities);
  const quarter = buildSeries(valid, firstByCust, t => periodKeys(t).quarter, null, topCities);
  const year    = buildSeries(valid, firstByCust, t => periodKeys(t).year, null, topCities);
  const allGeo  = buildSeries(valid, firstByCust, () => "ALL", null, topCities).geo.ALL || [];
  // monthly keeps its original `month` key for any older cached blob/consumer.
  const monthly = month.series.map(m => ({ month: m.period, revenue: m.revenue, orders: m.orders,
                                           buyers: m.buyers, aov: m.aov, newCustomers: m.newCustomers }));
  return { monthly, geo: allGeo, periods: { month, quarter, year } };
}

/* Phase 2 — partition rolled-up customers into B2B/B2C and score each cohort on its OWN
   quintiles + per-type thresholds, while ALSO scoring everyone together for the combined
   "All" view. Returns { agg (combined), byType:{B2B,B2C}, allCustomers (combined, scored,
   carrying customerType for the search index) }. Scoring is done on shallow copies so the
   cohort re-scoring never clobbers the combined R/F/M (cohorts are disjoint subsets). */
function segmentByCohort(rawCusts, cfg, storeKey) {
  rawCusts.forEach(c => { c.customerType = SEG.customerTypeOf(c, cfg); });
  const combined = SEG.scoreStore(rawCusts.map(c => ({ ...c })), cfg, storeKey, null);
  const agg = SEG.aggregate(combined, cfg, storeKey);
  const byType = {};
  for (const ct of ["B2B", "B2C"]) {
    const cohort = rawCusts.filter(c => c.customerType === ct).map(c => ({ ...c }));
    byType[ct] = SEG.aggregate(SEG.scoreStore(cohort, cfg, storeKey, ct), cfg, storeKey);
  }
  return { agg, byType, allCustomers: combined };
}

/* main entry. token falsy → demo mode. debug → returns one raw order. */
async function buildSegments({ storeKey, token, cfg, debug }) {
  const meta = { store: storeKey, generatedAt: Date.now() };
  if (!token) {
    const { agg, byType } = segmentByCohort(SEG.genSampleCustomers(storeKey, cfg), cfg, storeKey);
    const series = SEG.genSampleSeries(storeKey, cfg);
    return Object.assign({ source: "sample" }, meta, agg, { byType }, series);
  }
  const { orders, capped, totalPages } = await fetchAllOrders(token, cfg);
  if (debug) return { source: "debug", store: storeKey, ordersFetched: orders.length, totalPages, sampleOrder: orders[0] || null };
  const { agg, byType, allCustomers } = segmentByCohort(rollup(orders, cfg), cfg, storeKey);
  const series = timeSeries(orders, cfg);
  const out = Object.assign({ source: "live", ordersScanned: orders.length, capped }, meta, agg, { byType }, series);
  // full scored list (ALL customers, not just the top-100 in the aggregate) so the
  // refresh can persist a searchable index. Non-enumerable-ish: callers that send the
  // aggregate to the browser must strip this first (see refresh-background.js).
  out.allCustomers = allCustomers;
  return out;
}

module.exports = { buildSegments };
