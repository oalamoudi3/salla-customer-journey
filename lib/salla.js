/* =============================================================================
   salla.js — Node-only. Pulls orders from Salla, rolls them up per customer,
   then hands off to segmentation.js for scoring. Used by the serverless function.
   ============================================================================= */
const SEG = require("./segmentation.js");
const crypto = require("crypto");

const SALLA_BASE = "https://api.salla.dev/admin/v2";

/* #4 — one-way hash of a customer's mobile → a cross-store join key. The RAW mobile is
   never stored anywhere; only this 20-hex-char digest, which is identical for the same
   number across the three stores so we can match the same person. Returns null when no
   mobile is present (those customers simply don't participate in cross-store matching). */
function hashMobile(order, cfg) {
  const FM = cfg.FIELD_MAP || {};
  const m = FM.customerMobile ? readField(order, FM.customerMobile) : null;
  if (m == null || m === "") return null;
  const code = FM.customerMobileCode ? readField(order, FM.customerMobileCode) : "";
  const digits = String(code == null ? "" : code).replace(/\D/g, "") + String(m).replace(/\D/g, "");
  if (!digits) return null;
  return crypto.createHash("sha256").update(digits).digest("hex").slice(0, 20);
}

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

/* Generic paged GET with the same 429-aware retry + pacing as orders. Used for the
   abandoned-carts and products pulls. tolerant=true → on a page failure (after retries)
   return whatever was collected so far instead of throwing (these pulls are non-critical,
   and the Salla token is rate-limited aggressively, so partial data beats none). */
async function fetchAllPaged(token, path, perPage, maxPages, tolerant) {
  let page = 1, totalPages = 1, all = [];
  do {
    let json;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${SALLA_BASE}/${path}?per_page=${perPage}&page=${page}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        if (res.status === 401) { const e = new Error("UNAUTHORIZED"); e.code = 401; throw e; }
        if (res.status === 429) {
          if (attempt >= 6) { const e = new Error("Salla 429 (rate limited after retries)"); e.code = 429; throw e; }
          const ra = Number(res.headers.get("retry-after"));
          await sleep(ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 20000));
          continue;
        }
        if (!res.ok) { const e = new Error(`Salla ${res.status}`); e.code = res.status; throw e; }
        json = await res.json(); break;
      }
    } catch (e) {
      if (tolerant) break;   // keep the pages we already have
      throw e;
    }
    all = all.concat(json.data || []);
    totalPages = (json.pagination && json.pagination.totalPages) || 1;
    if (page >= maxPages) break;
    page++;
    if (page <= totalPages) await sleep(150);
  } while (page <= totalPages);
  return all;
}

/* #3 — abandoned/failed carts (did not become orders). Non-critical & tolerant. NOTE:
   /carts/abandoned caps per_page at 50 (per_page>50 → HTTP 422), so use cartsPerPage. */
async function fetchAllAbandoned(token, cfg) {
  try { return await fetchAllPaged(token, "carts/abandoned", cfg.PULL.cartsPerPage || 50, cfg.PULL.cartsMaxPages || 40, true); }
  catch (e) { return []; }
}

/* #2 — normalize a product/item name for matching (trim, lowercase, collapse spaces). */
function norm(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " "); }

/* #2 — build a normalized product-name → {cat, price} map from the catalog, so order-line
   items (which carry only name+quantity) can be attributed to a category. Non-critical:
   any failure returns {} (the category panel simply shows nothing). */
async function fetchProductMap(token, cfg) {
  try {
    const prods = await fetchAllPaged(token, "products", cfg.PULL.perPage, cfg.PULL.productsMaxPages || 120, true);
    const map = {};
    for (const p of prods) {
      const cat = (p.categories || [])[0];
      if (!cat) continue;
      const price = p.price && (p.price.amount != null ? p.price.amount : p.price);
      map[norm(p.name)] = { cat: cat.name || String(cat.id), price: Number(price) || 0 };
    }
    return map;
  } catch (e) { return {}; }
}

/* #2 — top categories per period from category line-events {t,cat,qty,rev}. keyOf buckets
   by month/quarter/year (or "ALL"); returns { periodKey → [{category,qty,revenue}] }. */
function categoriesByPeriod(catEvents, keyOf, topCats) {
  const byP = {};
  for (const e of catEvents) {
    const k = keyOf(e.t);
    const p = byP[k] || (byP[k] = {});
    const c = p[e.cat] || (p[e.cat] = { category: e.cat, qty: 0, revenue: 0 });
    c.qty += e.qty; c.revenue += e.rev;
  }
  const out = {};
  for (const k in byP) out[k] = Object.values(byP[k])
    .map(c => ({ category: c.category, qty: c.qty, revenue: Math.round(c.revenue) }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, topCats);
  return out;
}

/* roll abandoned carts into { count, value, top:[…] } (top N by cart value). Stores only
   first name + city (no email/mobile) so no sensitive PII lands in the blob. */
function abandonedSummary(carts, cfg) {
  const FM = cfg.CART_FIELD_MAP || {};
  const maxAgeMin = (cfg.PULL.abandonedMaxDays || 28) * 1440;
  const loggedInOnly = cfg.PULL.abandonedLoggedInOnly !== false;
  const now = Date.now();
  const rows = carts.map(c => {
    let name = readField(c, FM.customerFirst);
    const cid = FM.customerId ? readField(c, FM.customerId) : null;
    // age: prefer age_in_minutes, else derive from created_at
    let age = Number(readField(c, FM.ageMinutes));
    if (!(age > 0)) { const t = new Date(readField(c, FM.createdAt)).getTime(); age = isNaN(t) ? Infinity : Math.round((now - t) / 60000); }
    const items = Array.isArray(c.items) ? c.items.reduce((s, i) => s + (i.quantity || 1), 0) : 0;
    return {
      total: Math.round(Number(readField(c, FM.total)) || 0),
      customerId: cid == null ? null : String(cid),
      name: (name == null ? "" : String(name)).trim(),
      checkoutUrl: (readField(c, FM.checkoutUrl) || "") + "",
      items, ageMinutes: Math.round(age)
    };
  }).filter(r =>
    r.total > 0 &&
    (!loggedInOnly || (r.customerId && r.customerId !== "null")) && // logged-in customers only
    r.ageMinutes <= maxAgeMin                                       // recent (≤ abandonedMaxDays)
  );
  return {
    count: rows.length,
    value: rows.reduce((s, r) => s + r.total, 0),
    top: rows.sort((a, b) => b.total - a.total).slice(0, cfg.PULL.abandonedTopN || 10)
  };
}

/* #3b — recent payment transactions (failed-payments source, /admin/v2/transactions).
   Pulls newest-first and STOPS once a page is entirely older than txMaxDays, so the pull
   stays bounded on busy stores. Requires the transactions.read scope; tolerant, so a
   missing scope (401) or rate limit just yields what we have (often []). */
async function fetchRecentTransactions(token, cfg) {
  const perPage = cfg.PULL.txPerPage || 50, maxPages = cfg.PULL.txMaxPages || 80;
  const cutoff = Date.now() - (cfg.PULL.txMaxDays || 15) * 864e5;
  const FM = cfg.TX_FIELD_MAP || {};
  let page = 1, totalPages = 1, all = [];
  do {
    let json;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${SALLA_BASE}/transactions?per_page=${perPage}&page=${page}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        if (res.status === 429) { if (attempt >= 6) { const e = new Error("429"); e.code = 429; throw e; } const ra = Number(res.headers.get("retry-after")); await sleep(ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 20000)); continue; }
        if (!res.ok) { const e = new Error(`Salla ${res.status}`); e.code = res.status; throw e; } // 401 = no transactions.read scope
        json = await res.json(); break;
      }
    } catch (e) { break; } // tolerant
    const data = json.data || [];
    all = all.concat(data);
    totalPages = (json.pagination && json.pagination.totalPages) || 1;
    const oldest = data.length ? new Date(readField(data[data.length - 1], FM.createdAt)).getTime() : 0;
    if (data.length && oldest && oldest < cutoff) break;  // gone past the window (newest-first)
    if (page >= maxPages) break;
    page++;
    if (page <= totalPages) await sleep(150);
  } while (page <= totalPages);
  return all;
}

/* failed payments (status "canceled" = ملغية) within the window → summary + top-N by value.
   These are real payment attempts (method known) that did NOT become an order. PII-safe:
   stores customer id + name + MASKED card only (no email/mobile). */
function failedPaymentsSummary(txs, cfg) {
  const FM = cfg.TX_FIELD_MAP || {};
  const failed = new Set(cfg.FAILED_STATUS_SLUGS || ["canceled"]);
  const cutoff = Date.now() - (cfg.PULL.txMaxDays || 15) * 864e5;
  const rows = txs.map(t => {
    const created = new Date(readField(t, FM.createdAt)).getTime();
    const brand = readField(t, FM.cardBrand);
    const num = readField(t, FM.cardNumber);
    const last4 = num ? String(num).replace(/[^0-9]/g, "").slice(-4) : "";
    const cid = readField(t, FM.customerId);
    return {
      slug: readField(t, FM.statusSlug),
      createdMs: isNaN(created) ? 0 : created,
      txId: String(readField(t, FM.txId) || ""),
      customerId: cid == null ? null : String(cid),
      name: String(readField(t, FM.customerFirst) || "").trim(),
      amount: Math.round(Number(readField(t, FM.amount)) || 0),
      method: String(readField(t, FM.method) || "").trim(),
      card: brand ? (String(brand) + (last4 ? " ••" + last4 : "")) : (last4 ? "••" + last4 : ""),
      orderId: readField(t, FM.orderId) || null,
      createdAt: readField(t, FM.createdAt) || ""
    };
  }).filter(r => failed.has(r.slug) && r.amount > 0 && r.createdMs >= cutoff);
  return {
    count: rows.length,
    value: rows.reduce((s, r) => s + r.amount, 0),
    top: rows.sort((a, b) => b.amount - a.amount).slice(0, cfg.PULL.failedTopN || 10)
      .map(r => ({ txId: r.txId, customerId: r.customerId, name: r.name, amount: r.amount, method: r.method, card: r.card, orderId: r.orderId, createdAt: r.createdAt }))
  };
}

/* Salla-admin customer URL is hash-based (not constructible from the id), so fetch it for
   the handful of top rows that need a direct admin link. Tolerant + paced. */
async function fetchCustomerAdminUrls(token, ids, cfg) {
  const out = {};
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, (cfg.PULL.adminUrlTopN || 10) * 2);
  for (const id of uniq) {
    try {
      const res = await fetch(`${SALLA_BASE}/customers/${id}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (res.ok) { const d = (await res.json()).data || {}; const u = (d.urls && d.urls.admin) || ""; if (u) out[id] = u; }
    } catch (e) { /* skip */ }
    await sleep(80);
  }
  return out;
}

/* Build the status-slug Sets once (returned / pending / ignored). */
function statusSets(cfg) {
  return {
    returned: new Set(cfg.RETURNED_STATUS_SLUGS || []),
    pending:  new Set(cfg.PENDING_STATUS_SLUGS || []),
    ignored:  new Set(cfg.IGNORED_STATUS_SLUGS || [])
  };
}

/* Classify one order: "returned" | "pending" | "ignored" | "confirmed".
   Only "confirmed" counts as a real sale (revenue, AOV, RFM, top-earners, geo).
   "returned" is excluded from sales but counted/displayed separately.
   "pending" = awaiting payment (status slug OR is_pending_payment flag) → not a sale. */
function classifyOrder(o, cfg, sets) {
  const slug = readField(o, cfg.FIELD_MAP.statusSlug);
  if (sets.ignored.has(slug)) return "ignored";
  if (sets.returned.has(slug)) return "returned";
  const pendingFlag = cfg.FIELD_MAP.isPendingPayment ? readField(o, cfg.FIELD_MAP.isPendingPayment) : false;
  if (sets.pending.has(slug) || pendingFlag === true) return "pending";
  return "confirmed";
}

/* orders → one record per customer with recency/frequency/monetary (CONFIRMED orders only,
   so the top-earner ranking ignores cancelled/returned and awaiting-payment orders). */
function rollup(orders, cfg) {
  const now = Date.now();
  const cutoff = now - cfg.PULL.lookbackDays * 864e5;
  const sets = statusSets(cfg);
  const byCust = {};
  for (const o of orders) {
    if (classifyOrder(o, cfg, sets) !== "confirmed") continue;
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
    const c = byCust[cid] || (byCust[cid] = { id: cid, name, orders: 0, revenue: 0, last: 0, first: Infinity, b2bSignal: false, hashKey: null });
    c.orders++; c.revenue += amount;
    if (b2b) c.b2bSignal = true; // B2B if ANY of the customer's orders qualifies
    if (!c.hashKey) { const hk = hashMobile(o, cfg); if (hk) c.hashKey = hk; } // #4 cross-store key
    if (t > c.last) c.last = t;
    if (t < c.first) c.first = t;
    if ((c.name || "").startsWith("#") && !name.startsWith("#")) c.name = name;
  }
  return Object.values(byCust).map(c => ({
    id: c.id, name: c.name, orders: c.orders, revenue: Math.round(c.revenue),
    recencyDays: Math.floor((now - c.last) / 864e5),
    firstOrderDays: Math.floor((now - c.first) / 864e5),
    b2bSignal: c.b2bSignal, hashKey: c.hashKey
  }));
}

/* #4 — cross-store journey. storeHashes = { storeKey: Set(hashKey) } for the stores that
   were refreshed. A customer's CURRENT stage = the furthest store (in CROSS_JOURNEY.order)
   they've purchased from; the recommendation = the next store they haven't bought from.
   Returns aggregate funnel + recommendation counts (no per-customer PII). */
function computeJourney(storeHashes, cfg) {
  const order = ((cfg.CROSS_JOURNEY || {}).order || Object.keys(cfg.STORES || {})).filter(k => storeHashes[k]);
  const byHash = {};
  order.forEach(k => { for (const h of storeHashes[k]) (byHash[h] = byHash[h] || new Set()).add(k); });
  const perStore = {}; order.forEach(k => perStore[k] = 0);
  const stageDist = {}, recommend = {};
  let total = 0, multi = 0;
  for (const h in byHash) {
    total++;
    const stores = byHash[h];
    if (stores.size > 1) multi++;
    let furthestIdx = -1;
    order.forEach((k, i) => { if (stores.has(k)) { perStore[k]++; furthestIdx = i; } });
    const furthest = order[furthestIdx];
    stageDist[furthest] = (stageDist[furthest] || 0) + 1;
    const next = order[furthestIdx + 1];
    if (next && !stores.has(next)) recommend[next] = (recommend[next] || 0) + 1;
  }
  return { order, totalMatched: total, multiStore: multi, perStore, stageDist, recommend, generatedAt: Date.now() };
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
   periods (used for months); null keeps all (quarters/years).
   Inputs: valid = confirmed order events {t,cid,amt,city}; custReg = cid→{reg,first}
   (registration / earliest-order ms, for NEW-customer attribution by the period a
   customer joined); returnedEvents = timestamps of cancelled/returned orders (counted
   per period, shown separately). */
function buildSeries(valid, custReg, returnedEvents, keyOf, keepLast, topCities) {
  const periods = {}, geoByPeriod = {}, newByPeriod = {}, retByPeriod = {};
  // NEW customers = unique customers attributed to the period they registered in
  // (fall back to their earliest confirmed order if no registration date).
  for (const cid in custReg) {
    const cr = custReg[cid], ts = !isNaN(cr.reg) ? cr.reg : cr.first;
    if (!isFinite(ts)) continue;
    const k = keyOf(ts); newByPeriod[k] = (newByPeriod[k] || 0) + 1;
  }
  for (const t of returnedEvents) { const k = keyOf(t); retByPeriod[k] = (retByPeriod[k] || 0) + 1; }
  const ensure = (k) => periods[k] || (periods[k] = { period: k, revenue: 0, orders: 0, _buyers: new Set() });
  for (const v of valid) {
    const k = keyOf(v.t);
    const p = ensure(k);
    p.revenue += v.amt; p.orders++; p._buyers.add(v.cid);
    const g = geoByPeriod[k] || (geoByPeriod[k] = {});
    const ck = v.city || "0"; // placeholder for "unknown", relabelled in UI
    const gc = g[ck] || (g[ck] = { city: v.city, revenue: 0, orders: 0, _cust: new Set() });
    gc.revenue += v.amt; gc.orders++; gc._cust.add(v.cid);
  }
  // include periods that have only new-customer or returned activity (no confirmed sale)
  for (const k in newByPeriod) ensure(k);
  for (const k in retByPeriod) ensure(k);
  let series = Object.values(periods)
    .map(p => ({ period: p.period, revenue: Math.round(p.revenue), orders: p.orders, buyers: p._buyers.size,
                 aov: p.orders ? Math.round(p.revenue / p.orders) : 0,
                 newCustomers: newByPeriod[p.period] || 0, returned: retByPeriod[p.period] || 0 }))
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
   geo + cancelled/returned counts. CONFIRMED orders only feed sales/AOV/buyers/geo;
   cancelled/returned are excluded from sales but counted (returnedTotal + per-period
   `returned`); awaiting-payment / ignored orders are dropped. New customers per period =
   customers who REGISTERED (customer.created_at) in that period.
   #2 categories (period-aware) come from order line-items matched to the product catalog
   (prodMap: normalized name → {cat,price}); categoryMatchRate = % of confirmed line-items
   attributed to a category.
   Output: { monthly, geo, periods, returnedTotal, categories, categoriesByPeriod, categoryMatchRate } */
function timeSeries(orders, cfg, prodMap) {
  const FM = cfg.FIELD_MAP, sets = statusSets(cfg);
  const now = Date.now(), cutoff = now - cfg.PULL.lookbackDays * 864e5;
  const custReg = {}, valid = [], returnedEvents = [], catEvents = [];
  let totalItems = 0, matchedItems = 0;
  for (const o of orders) {
    const cls = classifyOrder(o, cfg, sets);
    if (cls === "ignored" || cls === "pending") continue;
    const t = new Date(readField(o, FM.createdAt)).getTime();
    if (isNaN(t) || t < cutoff) continue;
    if (cls === "returned") { returnedEvents.push(t); continue; }
    // confirmed:
    const cid = readField(o, FM.customerId); if (cid == null) continue;
    const amt = Number(readField(o, FM.total)) || 0;
    let city = readField(o, FM.shipCity);
    if (city && typeof city === "object") city = city.name || city.city || "";
    city = (city == null ? "" : String(city)).trim();
    valid.push({ t, cid, amt, city });
    const regRaw = FM.customerCreatedAt ? readField(o, FM.customerCreatedAt) : null;
    const regMs = regRaw ? new Date(regRaw).getTime() : NaN;
    const cr = custReg[cid] || (custReg[cid] = { reg: NaN, first: Infinity });
    if (!isNaN(regMs)) cr.reg = regMs;
    if (t < cr.first) cr.first = t;
    // #2 — attribute line-items to categories via the catalog name map
    if (prodMap && Array.isArray(o.items)) {
      for (const it of o.items) {
        totalItems++;
        const m = prodMap[norm(it.name)];
        if (!m) continue;
        matchedItems++;
        const qty = Number(it.quantity) || 1;
        catEvents.push({ t, cat: m.cat, qty, rev: qty * (m.price || 0) });
      }
    }
  }
  const topCities = cfg.PULL.geoTopCities || 20, topCats = cfg.PULL.topCategories || 12;
  const month   = buildSeries(valid, custReg, returnedEvents, t => periodKeys(t).month, cfg.PULL.monthlyMonths || 13, topCities);
  const quarter = buildSeries(valid, custReg, returnedEvents, t => periodKeys(t).quarter, null, topCities);
  const year    = buildSeries(valid, custReg, returnedEvents, t => periodKeys(t).year, null, topCities);
  const allGeo  = buildSeries(valid, custReg, returnedEvents, () => "ALL", null, topCities).geo.ALL || [];
  // monthly keeps its original `month` key for any older cached blob/consumer.
  const monthly = month.series.map(m => ({ month: m.period, revenue: m.revenue, orders: m.orders,
                                           buyers: m.buyers, aov: m.aov, newCustomers: m.newCustomers, returned: m.returned }));
  const catByP = {
    month:   categoriesByPeriod(catEvents, t => periodKeys(t).month, topCats),
    quarter: categoriesByPeriod(catEvents, t => periodKeys(t).quarter, topCats),
    year:    categoriesByPeriod(catEvents, t => periodKeys(t).year, topCats)
  };
  const catAll = (categoriesByPeriod(catEvents, () => "ALL", topCats)).ALL || [];
  return { monthly, geo: allGeo, periods: { month, quarter, year }, returnedTotal: returnedEvents.length,
           categories: catAll, categoriesByPeriod: catByP,
           categoryMatchRate: totalItems ? Math.round(matchedItems / totalItems * 100) : 0 };
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

/* main entry. token falsy → demo mode. debug → returns one raw order. prodMap (optional,
   supplied by refresh-background from its cache) drives the #2 category breakdown; when
   absent, categories are simply empty. */
async function buildSegments({ storeKey, token, cfg, debug, prodMap }) {
  const meta = { store: storeKey, generatedAt: Date.now() };
  if (!token) {
    const { agg, byType } = segmentByCohort(SEG.genSampleCustomers(storeKey, cfg), cfg, storeKey);
    const series = SEG.genSampleSeries(storeKey, cfg);
    return Object.assign({ source: "sample", returnedOrders: series.returnedTotal || 0, abandoned: SEG.genSampleAbandoned(storeKey, cfg), failedPayments: SEG.genSampleFailed(storeKey, cfg) }, meta, agg, { byType }, series);
  }
  const { orders, capped, totalPages } = await fetchAllOrders(token, cfg);
  if (debug) return { source: "debug", store: storeKey, ordersFetched: orders.length, totalPages, sampleOrder: orders[0] || null };
  const carts = await fetchAllAbandoned(token, cfg);             // #3 — non-critical pull
  const txs = await fetchRecentTransactions(token, cfg);         // #3b — failed payments (needs scope)
  const { agg, byType, allCustomers } = segmentByCohort(rollup(orders, cfg), cfg, storeKey);
  const series = timeSeries(orders, cfg, prodMap || {});         // #2 — prodMap supplied/cached by caller
  const out = Object.assign({ source: "live", ordersScanned: orders.length, capped }, meta, agg, { byType }, series);
  out.returnedOrders = series.returnedTotal || 0; // cancelled/returned count (excluded from sales)
  out.abandoned = abandonedSummary(carts, cfg);   // #3 — top abandoned carts by value
  out.failedPayments = failedPaymentsSummary(txs, cfg); // #3b — top failed payments by value
  // direct Salla-admin customer links for the top abandoned + failed rows (per request)
  try {
    const ids = [...(out.abandoned.top || []), ...(out.failedPayments.top || [])].map(r => r.customerId);
    const adminMap = await fetchCustomerAdminUrls(token, ids, cfg);
    (out.abandoned.top || []).forEach(r => { r.adminUrl = adminMap[r.customerId] || ""; });
    (out.failedPayments.top || []).forEach(r => { r.adminUrl = adminMap[r.customerId] || ""; });
  } catch (e) { /* admin links are best-effort */ }
  // full scored list (ALL customers, not just the top-100 in the aggregate) so the
  // refresh can persist a searchable index. Non-enumerable-ish: callers that send the
  // aggregate to the browser must strip this first (see refresh-background.js).
  out.allCustomers = allCustomers;
  return out;
}

module.exports = { buildSegments, rollup, timeSeries, classifyOrder, statusSets, computeJourney, fetchProductMap, abandonedSummary, fetchRecentTransactions, failedPaymentsSummary };
