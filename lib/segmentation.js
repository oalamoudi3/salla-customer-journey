/* =============================================================================
   segmentation.js — pure RFM scoring + lifecycle + sample generator.
   Single source of truth, used by BOTH the serverless function and the browser
   (for offline demo mode). No editing needed here — tune everything in config.js.
   ============================================================================= */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.SEG = factory();
})(typeof self !== "undefined" ? self : this, function () {

  function thresholds(cfg, storeKey) {
    const base = cfg.THRESHOLDS || {};
    const over = (cfg.STORES[storeKey] || {}).thresholds || {};
    return Object.assign({}, base, over);
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

  /* attaches R,F,M,segment,lifecycle,status,tier to every customer in place */
  function scoreStore(custs, cfg, storeKey) {
    const th = thresholds(cfg, storeKey);
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
        recencyDays: c.recencyDays, R: c.R, F: c.F, M: c.M, segment: c.segment, tier: c.tier
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
      arr.push({
        id: s.seed * 100000 + 1000 + i,
        name: FIRST[Math.floor(rnd() * FIRST.length)] + " " + LAST[Math.floor(rnd() * LAST.length)],
        orders, revenue: Math.round(aov * orders), recencyDays: recency, firstOrderDays: tenure
      });
    }
    return arr;
  }

  return { thresholds, scoreStore, aggregate, segmentOf, lifecycleOf, statusOf, genSampleCustomers };
});
