/* =============================================================================
   segmentation.js — pure RFM scoring + lifecycle + sample generator.
   Single source of truth, used by BOTH the serverless function and the browser
   (for offline demo mode). No editing needed here — tune everything in config.js.
   ============================================================================= */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.SEG = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* merge: global defaults ← per-store override ← per-customer-type override (last wins).
     custType is "B2B"/"B2C"/null. Lets a cohort widen its windows (e.g. B2B churn). */
  function thresholds(cfg, storeKey, custType) {
    const base = cfg.THRESHOLDS || {};
    const over = (cfg.STORES[storeKey] || {}).thresholds || {};
    const typeOver = custType ? ((cfg.THRESHOLDS_BY_TYPE || {})[custType] || {}) : {};
    return Object.assign({}, base, over, typeOver);
  }

  /* Saudi VAT number: exactly 15 digits, starting AND ending with 3. Rejects anything
     malformed so a bad/partial field never flips a customer to B2B by mistake. */
  function validVat(v) {
    if (v == null) return false;
    return /^3\d{13}3$/.test(String(v).replace(/\s/g, ""));
  }

  /* Decide B2B vs B2C. Primary signal: any of the customer's orders carried a valid VAT
     or a company name (rollup sets c.b2bSignal). Fallback when no signal: AOV ≥ a
     configurable threshold (CONFIG.CUSTOMER_TYPE.b2bAovThreshold, default 2000 SAR). */
  function customerTypeOf(c, cfg) {
    if (c.b2bSignal) return "B2B";
    const th = (cfg && cfg.CUSTOMER_TYPE) || {};
    const aov = c.orders ? c.revenue / c.orders : 0;
    return aov >= (th.b2bAovThreshold || 2000) ? "B2B" : "B2C";
  }

  /* Build an O(log n) quintile scorer from a presorted-ascending array. Reproduces
     the previous rank-based score exactly — score = ceil((#values ≤ v)/n × 5),
     clamped to 1..5 — but counts "≤ v" with a binary search (upper bound) instead
     of scanning the whole array per customer. invert=true → smaller value scores
     higher (used for recency). This makes scoreStore O(n log n), not O(n²). */
  function makeQuintileScorer(sortedAsc, invert) {
    const n = sortedAsc.length || 1;
    return function (v) {
      let lo = 0, hi = sortedAsc.length;            // upper bound: first index where x > v
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedAsc[mid] <= v) lo = mid + 1; else hi = mid; }
      const rank = lo / n;                          // == (#values ≤ v)/n, identical to before
      const s = Math.min(5, Math.max(1, Math.ceil(rank * 5)));
      return invert ? (6 - s) : s;
    };
  }

  function segmentOf(R, F, M) {
    const FM = Math.round((F + M) / 2);
    if (R >= 4 && FM >= 4) return "Champions";
    if (R >= 3 && FM >= 3) return "Loyal";
    if (R >= 4 && F <= 2) return "New";
    if (R >= 3 && FM <= 2) return "Potential Loyalists";
    if (R === 3 && FM === 3) return "Needs Attention";
    if (R <= 2 && FM >= 4) return "Can't-Lose-Them";
    if (R <= 2 && FM >= 3) return "At-Risk";
    if (R <= 2 && FM <= 2 && R >= 2) return "Hibernating";
    return "Lost";
  }

  function lifecycleOf(c, th) {
    if (c.firstOrderDays <= th.newTenureDays) return "New";
    if (c.recencyDays > th.churnedAfterDays) return "Churned";
    if (c.recencyDays >= th.lapsingMinDays) return "Lapsing";
    if (c.orders >= 2) return "Core";
    return "Lapsing";
  }

  function statusOf(rec, th) {
    return rec <= th.activeMaxDays ? "Active" : rec <= th.atRiskMaxDays ? "At-risk" : "Churned";
  }

  /* attaches R,F,M,segment,lifecycle,status,tier to every customer in place. custType
     (optional) selects per-cohort thresholds AND means the passed array is one cohort,
     so the quintiles below are computed within that cohort — exactly what Phase 2 needs. */
  function scoreStore(custs, cfg, storeKey, custType) {
    const th = thresholds(cfg, storeKey, custType);
    if (!custs.length) return custs;
    const scoreR = makeQuintileScorer(custs.map(c => c.recencyDays).sort((a, b) => a - b), true);
    const scoreF = makeQuintileScorer(custs.map(c => c.orders).sort((a, b) => a - b), false);
    const scoreM = makeQuintileScorer(custs.map(c => c.revenue).sort((a, b) => a - b), false);
    const monDesc = [...custs].sort((a, b) => b.revenue - a.revenue);
    const hiCut = Math.ceil(custs.length * th.highValuePct);
    const midCut = Math.ceil(custs.length * th.midValuePct);
    const high = new Set(monDesc.slice(0, hiCut).map(c => c.id));
    const mid = new Set(monDesc.slice(hiCut, midCut).map(c => c.id));
    custs.forEach(c => {
      c.R = scoreR(c.recencyDays);
      c.F = scoreF(c.orders);
      c.M = scoreM(c.revenue);
      c.segment = segmentOf(c.R, c.F, c.M);
      c.lifecycle = lifecycleOf(c, th);
      c.status = statusOf(c.recencyDays, th);
      c.tier = high.has(c.id) ? "High" : mid.has(c.id) ? "Mid" : "Low";
    });
    return custs;
  }

  /* roll the scored customers up into the object the dashboard renders */
  function aggregate(custs, cfg, storeKey) {
    const segs = {};
    custs.forEach(c => {
      (segs[c.segment] = segs[c.segment] || { count: 0, revenue: 0 });
      segs[c.segment].count++; segs[c.segment].revenue += c.revenue;
    });
    const total = custs.length || 1;
    const revenue = custs.reduce((s, c) => s + c.revenue, 0);
    const orders = custs.reduce((s, c) => s + c.orders, 0);
    const monDesc = [...custs].sort((a, b) => b.revenue - a.revenue);
    const top20 = monDesc.slice(0, Math.ceil(total * (cfg.THRESHOLDS.highValuePct)))
      .reduce((s, c) => s + c.revenue, 0);
    const life = { New: 0, Core: 0, Lapsing: 0, Churned: 0 };
    custs.forEach(c => life[c.lifecycle]++);
    return {
      total: custs.length,
      revenue, orders,
      repeat: custs.filter(c => c.orders >= 2).length,
      active: custs.filter(c => c.status === "Active").length,
      atrisk: custs.filter(c => c.status === "At-risk").length,
      churned: custs.filter(c => c.status === "Churned").length,
      aov: orders ? revenue / orders : 0,
      top20share: revenue ? top20 / revenue : 0,
      segments: segs,
      lifecycle: life,
      customers: monDesc.slice(0, 100).map(c => ({
        id: c.id, name: c.name, orders: c.orders, revenue: c.revenue,
        recencyDays: c.recencyDays, R: c.R, F: c.F, M: c.M, segment: c.segment, tier: c.tier,
        customerType: c.customerType
      }))
    };
  }

  /* deterministic sample population (demo mode only) */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const FIRST = ["Omar","Sara","Khalid","Noura","Faisal","Layla","Yousef","Huda","Bandar","Reem","Tariq","Maha","Saad","Lina","Majed","Dana","Nawaf","Aisha","Ziad","Rana"];
  const LAST = ["Al-Qahtani","Al-Harbi","Al-Otaibi","Al-Shehri","Al-Dossari","Al-Ghamdi","Al-Zahrani","Al-Mutairi","Al-Subaie","Al-Anazi"];

  function genSampleCustomers(storeKey, cfg) {
    const s = (cfg.STORES[storeKey] || {}).sample || { seed: 1, n: 100, aov: [100, 1000], repeat: 0.4 };
    const rnd = mulberry32(s.seed);
    const arr = [];
    for (let i = 0; i < s.n; i++) {
      const u = rnd();
      let recency;
      if (u < 0.42) recency = Math.floor(rnd() * 55);
      else if (u < 0.62) recency = 60 + Math.floor(rnd() * 30);
      else if (u < 0.82) recency = 91 + Math.floor(rnd() * 70);
      else recency = 160 + Math.floor(rnd() * 220);
      const isRepeat = rnd() < s.repeat;
      let orders = isRepeat ? 2 + Math.floor(rnd() * rnd() * 9) : 1;
      const tenure = recency + Math.floor(rnd() * rnd() * 420) + (orders > 1 ? 30 : 0);
      let aov = s.aov[0] + rnd() * rnd() * (s.aov[1] - s.aov[0]);
      if (rnd() < 0.08) aov *= (1.6 + rnd() * 1.8);
      // tag a deterministic ~22% share as B2B (company/VAT on file) with larger baskets,
      // so demo mode exercises the cohort split exactly like live data.
      const isB2B = rnd() < 0.22;
      if (isB2B) aov *= (1.7 + rnd() * 1.4);
      arr.push({
        id: s.seed * 100000 + 1000 + i,
        name: FIRST[Math.floor(rnd() * FIRST.length)] + " " + LAST[Math.floor(rnd() * LAST.length)],
        orders, revenue: Math.round(aov * orders), recencyDays: recency, firstOrderDays: tenure,
        b2bSignal: isB2B
      });
    }
    return arr;
  }

  /* deterministic sample trend (month/quarter/year) + per-period geo (demo/offline mode
     only). Mirrors the live timeSeries() output shape so the frontend renders identically
     in demo mode. Quarter/year uniques are folded from months with a small dedup factor
     (demo data only — live uniques are exact, computed per bucket on the server). */
  function genSampleSeries(storeKey, cfg) {
    const s = (cfg.STORES[storeKey] || {}).sample || { seed: 1, n: 100, aov: [100, 1000] };
    const rnd = mulberry32((s.seed || 1) + 99);
    const nMonths = (cfg.PULL && cfg.PULL.monthlyMonths) || 13;
    const topCities = (cfg.PULL && cfg.PULL.geoTopCities) || 20;
    const midAov = s.aov ? (s.aov[0] + s.aov[1]) / 2 : 400;
    const cities = ["الرياض", "جدة", "الدمام", "مكة المكرمة", "المدينة المنورة", "الخبر", "أبها", "تبوك", "بريدة", "الطائف"];
    const now = new Date();
    const monthSeries = [], monthGeo = {};
    for (let i = nMonths - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const period = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
      const orders = Math.max(5, Math.round((s.n || 100) * (0.25 + rnd() * 0.55)));
      const aov = Math.round(midAov * (0.7 + rnd() * 0.6));
      const revenue = orders * aov;
      monthSeries.push({ period, revenue, orders, aov, buyers: Math.round(orders * (0.7 + rnd() * 0.25)), newCustomers: Math.round(orders * (0.12 + rnd() * 0.2)), returned: Math.round(orders * (0.03 + rnd() * 0.06)) });
      monthGeo[period] = cities.map((city, j) => {
        const w = (cities.length - j) * (0.5 + rnd() * 1.0);
        const o = Math.max(1, Math.round(orders * 0.36 * w / cities.length));
        return { city, revenue: Math.round(o * aov), orders: o, customers: Math.max(1, Math.round(o * (0.55 + rnd() * 0.3))) };
      }).sort((a, b) => b.revenue - a.revenue).slice(0, topCities);
    }
    const fold = (keyOf) => {
      const map = {}, geo = {};
      monthSeries.forEach(m => {
        const k = keyOf(m.period);
        const p = map[k] || (map[k] = { period: k, revenue: 0, orders: 0, buyers: 0, newCustomers: 0, returned: 0 });
        p.revenue += m.revenue; p.orders += m.orders; p.buyers += m.buyers; p.newCustomers += m.newCustomers; p.returned += m.returned;
        const g = geo[k] || (geo[k] = {});
        (monthGeo[m.period] || []).forEach(c => {
          const gc = g[c.city] || (g[c.city] = { city: c.city, revenue: 0, orders: 0, customers: 0 });
          gc.revenue += c.revenue; gc.orders += c.orders; gc.customers += c.customers;
        });
      });
      const series = Object.values(map).map(p => ({ period: p.period, revenue: p.revenue, orders: p.orders,
        buyers: Math.round(p.buyers * 0.82), aov: p.orders ? Math.round(p.revenue / p.orders) : 0, newCustomers: p.newCustomers, returned: p.returned }))
        .sort((a, b) => (a.period < b.period ? -1 : 1));
      const geoOut = {};
      for (const k in geo) geoOut[k] = Object.values(geo[k])
        .map(c => ({ city: c.city, revenue: c.revenue, orders: c.orders, customers: Math.round(c.customers * 0.8) }))
        .sort((a, b) => b.revenue - a.revenue).slice(0, topCities);
      return { series, geo: geoOut };
    };
    const qKey = mk => { const p = mk.split("-"); return p[0] + "-Q" + (Math.floor((Number(p[1]) - 1) / 3) + 1); };
    const yKey = mk => mk.split("-")[0];
    const quarter = fold(qKey);
    const year = fold(yKey);
    // #2 — deterministic sample categories per month, folded to quarter/year + all-time
    const topCats = (cfg.PULL && cfg.PULL.topCategories) || 12;
    const CATS = ["الإضاءة", "السيراميك والبورسلان", "الحياة الذكية", "الأدوات الصحية", "حلول المياه", "ثريات", "إطارات", "المكيفات", "الدهانات", "الأبواب"];
    const catBase = CATS.map((c, i) => ({ c, w: (CATS.length - i) * (0.6 + rnd() * 0.8) }));
    const sumw = catBase.reduce((s, x) => s + x.w, 0);
    const monthCats = {};
    monthSeries.forEach(m => {
      const tot = m.revenue * 0.6;
      monthCats[m.period] = catBase.map(x => ({ category: x.c, revenue: Math.round(tot * x.w / sumw * (0.7 + rnd() * 0.6)), qty: 1 + Math.round(m.orders * x.w / sumw * 3) }))
        .sort((a, b) => b.revenue - a.revenue).slice(0, topCats);
    });
    const foldCats = (keyOf) => {
      const map = {};
      Object.keys(monthCats).forEach(mp => { const k = keyOf(mp); const g = map[k] || (map[k] = {}); monthCats[mp].forEach(c => { const gc = g[c.category] || (g[c.category] = { category: c.category, revenue: 0, qty: 0 }); gc.revenue += c.revenue; gc.qty += c.qty; }); });
      const out = {}; for (const k in map) out[k] = Object.values(map[k]).sort((a, b) => b.revenue - a.revenue).slice(0, topCats); return out;
    };
    const categoriesByPeriod = { month: monthCats, quarter: foldCats(qKey), year: foldCats(yKey) };
    const catAllMap = {};
    Object.values(monthCats).forEach(arr => arr.forEach(c => { const gc = catAllMap[c.category] || (catAllMap[c.category] = { category: c.category, revenue: 0, qty: 0 }); gc.revenue += c.revenue; gc.qty += c.qty; }));
    const categories = Object.values(catAllMap).sort((a, b) => b.revenue - a.revenue).slice(0, topCats);
    const monthly = monthSeries.map(m => ({ month: m.period, revenue: m.revenue, orders: m.orders, buyers: m.buyers, aov: m.aov, newCustomers: m.newCustomers, returned: m.returned }));
    const allGeo = {};
    monthSeries.forEach(m => (monthGeo[m.period] || []).forEach(c => {
      const gc = allGeo[c.city] || (allGeo[c.city] = { city: c.city, revenue: 0, orders: 0, customers: 0 });
      gc.revenue += c.revenue; gc.orders += c.orders; gc.customers += c.customers;
    }));
    const geo = Object.values(allGeo).map(c => ({ city: c.city, revenue: c.revenue, orders: c.orders, customers: Math.round(c.customers * 0.6) }))
      .sort((a, b) => b.revenue - a.revenue).slice(0, topCities);
    const returnedTotal = monthSeries.reduce((s, m) => s + (m.returned || 0), 0);
    return { monthly, geo, periods: { month: { series: monthSeries, geo: monthGeo }, quarter, year }, returnedTotal,
             categories, categoriesByPeriod, categoryMatchRate: 100 };
  }

  /* deterministic sample abandoned-cart summary (demo/offline mode only) */
  function genSampleAbandoned(storeKey, cfg) {
    const s = (cfg.STORES[storeKey] || {}).sample || { seed: 1, n: 100, aov: [100, 1000] };
    const rnd = mulberry32((s.seed || 1) + 7);
    const midAov = s.aov ? (s.aov[0] + s.aov[1]) / 2 : 400;
    const names = ["سعد", "نورة", "فيصل", "ليلى", "خالد", "ريم"];
    const n = (cfg.PULL && cfg.PULL.abandonedTopN) || 10;
    const maxAgeMin = ((cfg.PULL && cfg.PULL.abandonedMaxDays) || 28) * 1440;
    const top = [];
    for (let i = 0; i < n; i++) {
      const total = Math.round(midAov * (1.5 + rnd() * rnd() * 9) * (1 - i * 0.03));
      // demo carts are all logged-in (customerId + name) and within the recent window
      top.push({ total, customerId: String(700000 + Math.floor(rnd() * 99999)), name: names[Math.floor(rnd() * names.length)], checkoutUrl: "#", adminUrl: "#", items: 1 + Math.floor(rnd() * 6), ageMinutes: Math.floor(rnd() * maxAgeMin) });
    }
    top.sort((a, b) => b.total - a.total);
    const count = Math.max(top.length, Math.round((s.n || 100) * (0.3 + rnd() * 0.5)));
    const value = top.reduce((x, r) => x + r.total, 0) + Math.round(count * midAov * 0.6);
    return { count, value, top };
  }

  /* deterministic sample failed-payments summary (demo/offline mode only) */
  function genSampleFailed(storeKey, cfg) {
    const s = (cfg.STORES[storeKey] || {}).sample || { seed: 1, n: 100, aov: [100, 1000] };
    const rnd = mulberry32((s.seed || 1) + 13);
    const midAov = s.aov ? (s.aov[0] + s.aov[1]) / 2 : 400;
    const names = ["سعد", "نورة", "فيصل", "ليلى", "خالد", "ريم"];
    const methods = [["mada", "mada ••0553"], ["creditCard", "visa ••8435"], ["TamaraInstallment", ""], ["tabby", ""], ["applePay", "mastercard ••7763"]];
    const n = (cfg.PULL && cfg.PULL.failedTopN) || 10;
    const now = Date.now();
    const top = [];
    for (let i = 0; i < n; i++) {
      const m = methods[Math.floor(rnd() * methods.length)];
      const attempts = 1 + Math.floor(rnd() * rnd() * 5); // a few customers fail repeatedly
      top.push({ txId: String(800000000 + Math.floor(rnd() * 99999999)), customerId: String(700000 + Math.floor(rnd() * 99999)),
        name: names[Math.floor(rnd() * names.length)], value: Math.round(midAov * (1.0 + rnd() * rnd() * 5) * (1 - i * 0.03)), // AVERAGE attempt amount
        attempts, method: m[0], card: m[1], orderId: null, adminUrl: "#",
        createdAt: new Date(now - Math.floor(rnd() * 15 * 864e5)).toISOString().replace("T", " ").slice(0, 19) });
    }
    top.sort((a, b) => b.value - a.value);
    const customers = Math.max(top.length, Math.round((s.n || 100) * (0.08 + rnd() * 0.18)));
    const count = top.reduce((x, r) => x + r.attempts, 0) + Math.round(customers * 0.6);
    const value = top.reduce((x, r) => x + r.value, 0) + Math.round(customers * midAov * 0.5);
    return { count, customers, value, top };
  }

  return { thresholds, scoreStore, aggregate, segmentOf, lifecycleOf, statusOf, validVat, customerTypeOf, genSampleCustomers, genSampleSeries, genSampleAbandoned, genSampleFailed };
});
