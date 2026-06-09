/* =============================================================================
   CONFIG  —  EDIT EVERYTHING HERE
   هذا هو الملف الوحيد الذي تحتاج لتعديله لضبط كل شيء.
   -----------------------------------------------------------------------------
   This single file controls:
     1) STORES        → which stores, their Salla store IDs, and token env names
     2) THRESHOLDS    → every segmentation cutoff (global + per-store overrides)
     3) LOOKBACK/PULL → how far back to pull orders, page caps
     4) FIELD_MAP     → where to read values inside a Salla order (verify once!)
     5) EXCLUDED_STATUS_SLUGS → which order statuses to ignore
     6) SEGMENTS      → colours, journey stage, recommended play, channels (Arabic)
     7) JOURNEY       → the 6 stages (Arabic)
     8) UI            → all on-screen Arabic text
   Works in both the browser (window.CONFIG) and the serverless function (require).
   ============================================================================= */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.CONFIG = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const CONFIG = {

    /* 1) ───────── STORES ─────────────────────────────────────────────────────
       id        : the Salla store id (numeric, as string)
       tokenEnv  : the environment-variable name that holds this store's Salla
                   ACCESS TOKEN on Vercel/Netlify. (Never hard-code tokens here.)
       sample    : parameters used only when no token is set (demo mode).
       thresholds: OPTIONAL per-store overrides of the global THRESHOLDS below. */
    STORES: {
      BUILD_STATION: {
        id: "1327714595",
        label: "BUILD_STATION",
        noteAr: "تجزئة كبيرة · أكثر من 9000 منتج · فروع متعددة",
        tokenEnv: "SALLA_TOKEN_BUILD_STATION",
        sample: { seed: 11, n: 260, aov: [180, 1400], repeat: 0.46 }
        // thresholds: { churnedAfterDays: 120 }   // example per-store override
      },
      LIGHTING: {
        id: "604322063",                       // ← TODO: put the LIGHTING store id
        label: "LIGHTING",
        noteAr: "مشتريات تحتاج تفكيرًا · قيمة طلب أعلى",
        tokenEnv: "SALLA_TOKEN_LIGHTING",
        sample: { seed: 23, n: 140, aov: [140, 2600], repeat: 0.34 },
        thresholds: { activeMaxDays: 90, atRiskMaxDays: 150, churnedAfterDays: 150, lapsingMinDays: 90 }
        // ↑ LIGHTING repeats more slowly, so its "quiet" windows are wider.
      },
      HATCH: {
        id: "1437000859",                       // ← TODO: put the HATCH store id
        label: "HATCH",
        noteAr: "طلبات متكررة منخفضة القيمة · ولاء قوي",
        tokenEnv: "SALLA_TOKEN_HATCH",
        sample: { seed: 37, n: 95, aov: [90, 520], repeat: 0.52 }
      }
    },

    /* 2) ───────── THRESHOLDS (global defaults; override per store above) ──────
       All in DAYS unless it's a percentage (0–1). */
    THRESHOLDS: {
      newTenureDays:    30,   // first order within this many days → lifecycle "New"
      activeMaxDays:    60,   // last order ≤ this → status "Active"
      atRiskMaxDays:    90,   // last order ≤ this (and > active) → "At-risk"; else "Churned"
      lapsingMinDays:   60,   // recency ≥ this (and not churned) → lifecycle "Lapsing"
      churnedAfterDays: 90,   // recency > this → lifecycle "Churned"
      highValuePct:     0.20, // top 20% of spend → value tier "High"
      midValuePct:      0.50  // next up to 50%  → "Mid"; remainder → "Low"
    },

    /* 2b) ──────── B2B vs B2C (Phase 2) ───────────────────────────────────────
       CUSTOMER_TYPE.b2bAovThreshold: when a customer has NO VAT/company signal,
       an average order value at/above this (SAR) classifies them B2B.
       THRESHOLDS_BY_TYPE: optional per-cohort overrides of the THRESHOLDS above
       (merged last, so a cohort wins). Contractors (B2B) reorder on project cadence,
       so their "quiet" windows are much wider than a consumer's. */
    CUSTOMER_TYPE: {
      b2bAovThreshold: 2000   // SAR; fallback signal when no VAT/company present
    },
    THRESHOLDS_BY_TYPE: {
      B2B: { activeMaxDays: 120, atRiskMaxDays: 240, churnedAfterDays: 240, lapsingMinDays: 120, newTenureDays: 45 },
      B2C: {}                 // consumers use the global defaults
    },

    /* 2c) ──────── CROSS-STORE CUSTOMER JOURNEY (#4) ───────────────────────────
       The three stores are project STAGES: a buyer of building materials is mid-
       construction → next they need lighting, then finishing/smart touches. Customers
       are matched across stores by a one-way hash of their mobile (raw mobile never
       stored). `order` is the stage sequence; a customer's CURRENT stage = the furthest
       store they've purchased from; the recommendation = the next store they haven't
       bought from yet. Edit the order/labels here to retune the journey. */
    CROSS_JOURNEY: {
      order: ["BUILD_STATION", "LIGHTING", "HATCH"],
      stageAr: {
        BUILD_STATION: "مرحلة البناء (مواد البناء)",
        LIGHTING:      "مرحلة الإضاءة",
        HATCH:         "مرحلة التجهيز واللمسات الأخيرة"
      },
      // what to recommend to a customer whose furthest stage is each store:
      recommendAr: {
        BUILD_STATION: "العميل يبني الآن → اقترح منتجات الإضاءة",
        LIGHTING:      "انتهى من الإضاءة → اقترح السيراميك والمنتجات الذكية واللمسات الأخيرة",
        HATCH:         "عميل أكمل الرحلة → برامج ولاء وإعادة شراء وترشيح"
      }
    },

    /* 3) ───────── PULL SETTINGS ───────────────────────────────────────────── */
    PULL: {
      lookbackDays: 365,  // only orders newer than this feed Recency/Frequency/Monetary
      perPage:      100,  // Salla page size
      maxPages:     250,  // hard cap. The NIGHTLY BACKGROUND FUNCTION does the pull now
                          // (15-min budget), so this can comfortably cover the biggest
                          // store (HATCH ≈ 198 pages). The request-time endpoint no longer
                          // pulls from Salla — it just reads the precomputed JSON from Blobs.
      monthlyMonths: 13,  // how many trailing months to keep in the monthly trend series
      geoTopCities:  20,  // how many cities to keep in the geographic breakdown
      cartsMaxPages: 40,  // hard cap on abandoned-cart pages pulled
      cartsPerPage:  50,  // /carts/abandoned caps page size at 50 (per_page>50 → HTTP 422)
      abandonedTopN: 10,  // how many highest-value abandoned carts to surface
      abandonedMaxDays: 28, // only count abandoned carts newer than this (recent, actionable)
      abandonedLoggedInOnly: true, // only carts tied to a logged-in customer (have customer.id)
      productsMaxPages: 120, // hard cap on product-catalog pages (builds the name→category map)
      topCategories: 12,  // how many categories to keep per period in the category breakdown
      productMapMaxAgeDays: 7 // re-pull the (heavy) product→category map only when the cached
                              // one is older than this; keeps nightly runs light so the orders/
                              // carts pulls aren't rate-limited. Catalogs change slowly.
    },

    /* 3b) ─────── ABANDONED-CART field map (Salla /carts/abandoned) ────────────── */
    CART_FIELD_MAP: {
      total:         { path: "total.amount",        fallback: ["total"] },
      customerId:    { path: "customer.id",          fallback: [] },   // logged-in marker + lookup key
      customerFirst: { path: "customer.first_name",  fallback: ["customer.full_name", "customer.name"] },
      checkoutUrl:   { path: "checkout_url",          fallback: ["urls.checkout"] }, // "open in Salla" link
      ageMinutes:    { path: "age_in_minutes",       fallback: [] },
      createdAt:     { path: "created_at.date",       fallback: ["created_at"] }
      // NOTE: Salla does NOT record a payment method on abandoned carts (verified) — a cart
      // is abandoned before payment, so there is no "failed payment method" field to read.
    },

    /* 4) ───────── FIELD_MAP — where to read each value inside a Salla order ───
       VERIFY ONCE against your real payload:  /api/segments?store=BUILD_STATION&debug=1
       returns one raw order so you can confirm these paths. The code also tries the
       listed fallbacks automatically, so small differences usually just work. */
    FIELD_MAP: {
      customerId:       { path: "customer.id",            fallback: ["customer_id"] },
      customerFirst:    { path: "customer.first_name",    fallback: ["customer.name"] },
      customerLast:     { path: "customer.last_name",     fallback: [] },
      createdAt:        { path: "date.date",              fallback: ["created_at", "date"] },
      total:            { path: "amounts.total.amount",   fallback: ["total.amount", "total", "amounts.total"] },
      statusSlug:       { path: "status.slug",            fallback: ["status.name"] },
      // City for the geographic view. NOTE: the orders LIST payload does NOT include
      // ship_to (national address) — that only appears on single-order detail, which
      // would mean one extra call per order. So we read customer.city here (present in
      // the list payload). ship_to.city is kept as the primary path in case Salla adds
      // it to the list later. VERIFY via ?debug=1.  value may be a string or {name}.
      shipCity:         { path: "ship_to.city",           fallback: ["customer.city", "shipping.city", "ship_to.city.name"] },
      // B2B detection (Phase 2). UNCONFIRMED paths — verify against a real order via
      // ?debug=1 and adjust. A valid VAT (15 digits, starts+ends with 3) OR any company
      // name on ANY of a customer's orders marks them B2B; otherwise the AOV heuristic
      // (CUSTOMER_TYPE.b2bAovThreshold) decides. Leave generous fallbacks here.
      vatNumber:        { path: "ship_to.vat_number",     fallback: ["vat_number", "customer.vat_number", "tax_number", "ship_to.tax_number"] },
      company:          { path: "ship_to.company",        fallback: ["company", "customer.company", "ship_to.company_name"] },
      // is_pending_payment → an unpaid order awaiting payment (excluded from confirmed sales).
      isPendingPayment: { path: "is_pending_payment",     fallback: [] },
      // customer registration date → drives "new customers per period" (who joined when).
      // Salla returns {date:"YYYY-MM-DD HH:mm:ss…",timezone…}; .date holds the timestamp.
      customerCreatedAt:{ path: "customer.created_at.date", fallback: ["customer.created_at"] },
      // mobile → hashed (one-way) into a cross-store join key for the customer journey (#4).
      // The RAW mobile is NEVER stored; only its hash. mobile_code is prepended when present.
      customerMobile:   { path: "customer.mobile",         fallback: [] },
      customerMobileCode:{ path: "customer.mobile_code",   fallback: [] }
    },

    /* 5) ───────── ORDER STATUS HANDLING ──────────────────────────────────────
       Slugs verified via GET /admin/v2/orders/statuses. Each order is classified
       once (see lib/salla.js → classifyOrder):
         RETURNED  → cancelled / returned: NOT counted as a sale, but COUNTED and
                     shown separately (the "returned/cancelled orders" number).
         PENDING   → awaiting payment: NOT a confirmed sale — excluded from revenue,
                     AOV, RFM and the top-earner ranking. Also any order flagged
                     is_pending_payment=true is treated as PENDING regardless of slug.
         IGNORED   → not a sale at all (deleted order, quote request): excluded entirely.
         CONFIRMED → everything else (under_review/in_progress/completed/delivering/
                     delivered): counts toward all sales & customer metrics.
       NOTE: Salla uses the American spelling "canceled"; "restored"=returned. */
    RETURNED_STATUS_SLUGS: ["canceled", "restored", "restoring", "refunded"],
    PENDING_STATUS_SLUGS:  ["payment_pending"],
    IGNORED_STATUS_SLUGS:  ["deleted", "request_quote"],
    // kept for backward-compatibility (older code paths) = returned ∪ pending ∪ ignored.
    EXCLUDED_STATUS_SLUGS: ["canceled", "restored", "restoring", "refunded", "payment_pending", "deleted", "request_quote"],

    /* 6) ───────── SEGMENTS — colour · journey stage · play · channels ────────
       stage must match a JOURNEY name below. channels ∈ {salla, ads, email}. */
    SEGMENTS: {
      "Champions":           { ar: "الأبطال",            color: "#34d399", stage: "Advocacy",     ar_play: "وصول مبكر VIP + طلب ترشيح؛ بناء جمهور مشابه عالي القيمة.", channels: ["salla","ads","email"] },
      "Loyal":               { ar: "الأوفياء",           color: "#4f8cff", stage: "Retention",    ar_play: "عروض مكمّلة (Cross-sell) + نقاط ولاء؛ حمايتهم بمزايا.",     channels: ["salla","email"] },
      "Potential Loyalists": { ar: "أوفياء محتملون",      color: "#22d3ee", stage: "Retention",    ar_play: "تحفيز الطلب الثاني/الثالث؛ حفظ وسيلة الدفع + اقتراح المنتج التالي.", channels: ["email","ads"] },
      "New":                 { ar: "عملاء جدد",          color: "#a3e635", stage: "Onboarding",   ar_play: "سلسلة ترحيب + شرح الاستخدام (اليوم الثالث) لتقليل التسرّب المبكر.", channels: ["email"] },
      "Needs Attention":     { ar: "يحتاجون اهتمامًا",    color: "#fbbf24", stage: "Retention",    ar_play: "عرض محدّد بوقت قبل تراجعهم؛ إبراز الأكثر مبيعًا.",          channels: ["email","ads"] },
      "At-Risk":             { ar: "معرّضون للخطر",       color: "#fb923c", stage: "Retention",    ar_play: "خصم «اشتقنا لك» + استبيان رأي قصير.",                      channels: ["email","ads"] },
      "Can't-Lose-Them":     { ar: "لا يمكن خسارتهم",     color: "#f472b6", stage: "Retention",    ar_play: "استعادة عالية اللمسة — كانوا عملاء قيّمين. حافز قوي.",      channels: ["email","ads","salla"] },
      "Hibernating":         { ar: "خاملون",             color: "#a78bfa", stage: "Awareness",    ar_play: "إعادة تنشيط منخفضة التكلفة؛ إعادة تقديم العلامة + وصل حديثًا.", channels: ["ads","email"] },
      "Lost":                { ar: "مفقودون",            color: "#f87171", stage: "Awareness",    ar_play: "إعادة تنشيط رخيصة أو استبعادهم من الاستقطاب لتوفير الإنفاق.",  channels: ["email"] }
    },

    /* 7) ───────── JOURNEY — the 6 stages (Arabic) ───────────────────────────── */
    JOURNEY: [
      { name: "Awareness",     ar: "الوعي",      sales: "جذب زيارات مؤهلة",        exp: "عرض قيمة واضح وملائم",                 mot: "ملاءمة الإعلان مع صفحة الوصول؛ أول 3 ثوانٍ" },
      { name: "Consideration", ar: "المفاضلة",   sales: "تقليل التردد",            exp: "معالجة اعتراضات السعر / الثقة / الميزات", mot: "سرعة صفحة المنتج + ظهور التقييمات أعلى الصفحة" },
      { name: "Purchase",      ar: "الشراء",     sales: "رفع متوسط الطلب والتحويل", exp: "إزالة الاحتكاك (ضيف، دفع بنقرة)",       mot: "عدد حقول الدفع ونسبة التخلّي" },
      { name: "Onboarding",    ar: "التهيئة",    sales: "تقليل التسرّب المبكر",     exp: "احتفاء + تعليم الميزة الأساسية",        mot: "بريد شرح اليوم الثالث ← مرتجعات أقل" },
      { name: "Retention",     ar: "الاحتفاظ",   sales: "زيادة الشراء المتكرر",     exp: "مفاجأة وإبهاج",                        mot: "Cross-sell في صفحة الشكر ← +10–30% بمتوسط الطلب" },
      { name: "Advocacy",      ar: "المناصرة",   sales: "توليد الترشيحات",          exp: "تسهيل المشاركة ومكافأتها",             mot: "طلب الترشيح عند ذروة الرضا" }
    ],

    /* 8) ───────── UI — all on-screen Arabic text ─────────────────────────────
       Change wording here without touching the dashboard code. */
    UI: {
      title: "تجزئة العملاء ورحلتهم",
      subtitle: "شرائح RFM · دورة الحياة · مراحل الرحلة · تفعيل الحملات — عبر متاجر سلة",
      live: "بيانات مباشرة", sample: "بيانات تجريبية", offline: "تجريبي (الواجهة الخلفية غير مفعّلة)",
      updated: "آخر تحديث",
      bannerSample: "أنت تشاهد بيانات تجريبية. اضبط مفاتيح الـ Tokens في إعدادات الاستضافة لعرض بيانات المتجر الحقيقية (انظر README).",
      ordersScanned: "طلب تم فحصه",
      kpis: {
        customers: "العملاء", active: "النشطون", atrisk: "معرّضون للخطر", churned: "منسحبون",
        repeat: "معدل الشراء المتكرر", aov: "متوسط قيمة الطلب", revenue: "الإيرادات", top20: "حصة أعلى 20%",
        returned: "طلبات ملغاة/مرتجعة"
      },
      kpiDesc: {
        active: "% من القاعدة", atrisk: "هدوء 61–90 يومًا", churned: "هدوء أكثر من 90 يومًا",
        repeatBuyers: "مشترٍ متكرر", orders: "طلب", revenue: "إجمالي (في فترة المراجعة)", ofRevenue: "من الإيرادات",
        returned: "غير محتسبة في المبيعات (مؤكدة فقط)"
      },
      segChartTitle: "العملاء حسب شريحة RFM",
      revChartTitle: "مساهمة الإيرادات حسب الشريحة",
      funnelTitle: "قمع دورة الحياة",
      lifecycle: { New: "جدد", Core: "أساسيون", Lapsing: "متراجعون", Churned: "منسحبون" },
      ofBase: "من القاعدة",
      journeyTitle: "مراحل الرحلة ولحظات الحقيقة",
      journeySub: "لكل مرحلة هدف مبيعات، هدف تجربة، اللحظة الفاصلة، والشرائح الموجودة فيها الآن",
      labelSales: "المبيعات", labelExp: "التجربة", labelMot: "لحظة الحقيقة",
      actTitle: "تفعيل الشرائح — الإجراءات المقترحة والقنوات",
      actCols: { segment: "الشريحة", count: "العملاء", revenue: "الإيرادات", stage: "مرحلة الرحلة", play: "الإجراء المقترح", channels: "القنوات", export: "" },
      exportBtn: "تصدير",
      channels: { salla: "مجموعة سلة", ads: "Meta / TikTok / Snap", email: "البريد" },
      custTitle: "العملاء", custMatches: "نتيجة مطابقة", custMatchesPl: "نتيجة مطابقة",
      custCols: { id: "العميل", orders: "الطلبات", revenue: "الإيرادات", recency: "آخر طلب", segment: "الشريحة", tier: "القيمة" },
      filterLabel: "تصفية حسب الشريحة", allSegments: "كل الشرائح",
      showingTop: "عرض أعلى 100 حسب الإيرادات. تُحتسب درجات R/F/M من 1 إلى 5 ضمن كل متجر على حدة.",
      daysAgo: "يومًا",
      tiers: { High: "عالية", Mid: "متوسطة", Low: "منخفضة" },
      exportToast: (n, seg, store, chans) => `محاكاة: سيتم دفع ${n} عميلًا من شريحة «${seg}» في ${store} ← ${chans}. الربط الفعلي في المرحلة الثانية.`,
      search: {
        placeholder: "ابحث برقم العميل أو الاسم…",
        btn: "بحث",
        clear: "كل العملاء ↺",
        searching: "جارٍ البحث…",
        noResult: "لا توجد نتائج مطابقة",
        needRefresh: "لم يُبنَ فهرس البحث بعد — شغّل التحديث الليلي أولًا.",
        matchesTitle: "نتائج مطابقة",
        view: "عرض",
        email: "البريد", mobile: "الجوال", city: "المدينة",
        openInSalla: "فتح في لوحة سلة",
        noContact: "تعذّر جلب بيانات التواصل (تحقق من التوكن)."
      },
      auth: {
        prompt: "هذه اللوحة محمية. أدخل كلمة مرور الوصول للمتابعة:",
        wrong: "كلمة المرور غير صحيحة. حاول مرة أخرى."
      },
      monthly: {
        filterLabel: "الفترة",
        granLabel: "التجميع",
        gran: { month: "شهري", quarter: "ربعي", year: "سنوي" },
        allTime: "كل الفترة",
        trendsTitle: "الاتجاهات عبر الزمن",
        tableTitle: "التفصيل حسب الفترة (للتقرير)",
        revLabel: "المبيعات",
        ordersLabel: "الطلبات",
        newCustomers: "عملاء جدد",
        buyers: "عملاء مشترون",
        exportBtn: "تصدير CSV",
        exportTitle: "تنزيل تقرير الفترة كملف CSV",
        vsPrev: "مقارنة بالسابق",
        returnedLabel: "طلبات ملغاة/مرتجعة",
        cols: { period: "الفترة", month: "الشهر", sales: "المبيعات", orders: "الطلبات", aov: "متوسط الطلب", newCust: "عملاء جدد", buyers: "المشترون", returned: "ملغاة/مرتجعة" },
        geoForPeriod: "التوزيع الجغرافي للفترة",
        snapshotNote: "ملاحظة: الشرائح ودورة الحياة ومراحل الرحلة تعكس الوضع الحالي ولا تتأثر بفلتر الفترة. المبيعات/الطلبات/متوسط الطلب تحتسب الطلبات المؤكدة فقط (تُستثنى الملغاة/المرتجعة والطلبات بانتظار الدفع، وتُعرض الملغاة/المرتجعة كعدد منفصل). «عملاء جدد» = العملاء الذين سجّلوا حساباتهم في تلك الفترة."
      },
      /* Phase 2 — B2B / B2C cohort toggle. */
      customerType: { label: "نوع العميل", all: "الكل", b2b: "شركات (B2B)", b2c: "أفراد (B2C)" },
      geo: {
        title: "التوزيع الجغرافي — أعلى المدن",
        sub: "حسب مدينة العميل (الإيرادات وعدد العملاء)",
        cols: { city: "المدينة", revenue: "الإيرادات", customers: "العملاء", orders: "الطلبات" },
        unknown: "غير محدد"
      },
      /* #3 — abandoned / failed carts (did not turn into orders) */
      abandoned: {
        title: "أعلى السلال المتروكة (لم تُكمل الدفع)",
        sub: "عملاء مسجّلون فقط · آخر ٢٨ يومًا · أعلى ١٠ من حيث القيمة",
        count: "السلال المتروكة (٢٨ يومًا)",
        value: "قيمتها الإجمالية",
        cols: { customer: "العميل", value: "القيمة", items: "العناصر", salla: "فتح في سلة", age: "منذ" },
        guest: "زائر",
        openCart: "فتح ↗", view: "عرض العميل",
        ageMin: "د", ageHour: "س", ageDay: "ي"
      },
      /* #4 — cross-store customer journey */
      journey2: {
        title: "رحلة العميل عبر المتاجر",
        sub: "مطابقة العملاء عبر المتاجر الثلاثة (عبر بصمة الجوال) — في أي مرحلة هم الآن وما الخطوة التالية",
        matchedNote: (n, m) => `طُوبق ${n} عميلًا عبر المتاجر · ${m} منهم اشتروا من أكثر من متجر.`,
        stageCol: "المرحلة الحالية", countCol: "عملاء", recCol: "الإجراء/التوصية المقترحة",
        funnelTitle: "توزيع العملاء حسب المرحلة",
        recoTitle: "فرص الترقية للمرحلة التالية",
        recoLine: (n, store) => `${n} عميلًا جاهزون للانتقال إلى «${store}»`,
        coverageNote: "ملاحظة: تعتمد المطابقة على وجود رقم جوال للعميل؛ العملاء بدون جوال لا تُحتسب في المطابقة العابرة للمتاجر.",
        none: "لم يُحتسب بعد — شغّل التحديث الليلي."
      },
      /* #2 — top selling categories (period-aware) */
      categories: {
        title: "أعلى الفئات مبيعًا",
        sub: "حسب القيمة المدفوعة — يتبع فلتر الفترة أعلاه",
        cols: { category: "الفئة", revenue: "القيمة", qty: "الكمية", share: "الحصة" },
        matchNote: (pct) => `مبني على مطابقة أسماء المنتجات (طُوبق ${pct}% من عناصر الطلبات بالكتالوج).`,
        unmatched: "غير مصنّف"
      },
      footer: "نسخة مباشرة · العتبات قابلة للتعديل من ملف config.js"
    }
  };
  return CONFIG;
});
