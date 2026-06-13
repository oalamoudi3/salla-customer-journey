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
        logo: "./Build_Station_Logo.jpeg",
        brand: { accent: "#2a9fc4", accent2: "#5fa630" },   // Build Station cyan
        sample: { seed: 11, n: 260, aov: [180, 1400], repeat: 0.46 }
        // thresholds: { churnedAfterDays: 120 }   // example per-store override
      },
      LIGHTING: {
        id: "604322063",
        label: "LIGHTING",
        noteAr: "مشتريات تحتاج تفكيرًا · قيمة طلب أعلى",
        tokenEnv: "SALLA_TOKEN_LIGHTING",
        logo: "./Lighting_Logo.jpeg",
        brand: { accent: "#5fa630", accent2: "#2a9fc4" },   // Lighting green
        sample: { seed: 23, n: 140, aov: [140, 2600], repeat: 0.34 },
        thresholds: { activeMaxDays: 90, atRiskMaxDays: 150, churnedAfterDays: 150, lapsingMinDays: 90 }
        // ↑ LIGHTING repeats more slowly, so its "quiet" windows are wider.
      },
      HATCH: {
        id: "1437000859",
        label: "HATCH",
        noteAr: "طلبات متكررة منخفضة القيمة · ولاء قوي",
        tokenEnv: "SALLA_TOKEN_HATCH",
        logo: "./Hatch_Logo.jpeg",
        brand: { accent: "#6b7c89", accent2: "#8493a0" },   // Hatch monochrome slate (works on light+dark)
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
      candidateSample: 15,   // how many actionable candidate customers to list per recommendation
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
      txPerPage:     50,  // /transactions page size
      txMaxPages:    80,  // safety cap on transaction pages (recent-first; we stop at txMaxDays)
      txMaxDays:     15,  // failed-payments window (matches the Salla "last 15 days" log)
      failedTopN:    10,  // how many highest-value FAILED payments to surface
      adminUrlTopN:  10,  // fetch the Salla-admin customer URL for this many top rows per panel
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

    /* 3c) ─────── TRANSACTIONS (Salla /admin/v2/transactions) — FAILED PAYMENTS ────
       The electronic-payments log (s.salla.sa/log/transactions). Requires the Salla app
       scope `transactions.read`. A FAILED payment = status.slug "canceled" (ملغية) — these
       are real payment attempts (method known) that did NOT become an order (order_id null). */
    FAILED_STATUS_SLUGS: ["canceled"],
    TX_FIELD_MAP: {
      txId:          { path: "id",                    fallback: ["references.transaction"] },
      customerId:    { path: "customer.id",            fallback: [] },
      customerFirst: { path: "customer.first_name",    fallback: ["customer.full_name"] },
      amount:        { path: "total.amount",           fallback: ["total"] },
      statusSlug:    { path: "status.slug",            fallback: [] },
      method:        { path: "payment_method.name",    fallback: ["payment_method.slug"] },
      cardBrand:     { path: "card.brand",             fallback: [] },
      cardNumber:    { path: "card.number",            fallback: [] },
      orderId:       { path: "references.order_id",     fallback: [] },
      createdAt:     { path: "created_at.date",         fallback: ["created_at"] }
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

    /* 7b) ──────── GLOSSARY — "how to read this dashboard" for the team ─────────
       Plain-Arabic explanations of the methodology (RFM, segments, lifecycle, journey…).
       Rendered in a collapsible panel. Edit freely. */
    GLOSSARY: [
      { h: "كيف نقسّم العملاء؟ (RFM)", items: [
        ["وش يعني RFM؟", "ثلاث درجات لكل عميل: آخر مرة اشترى فيها (R)، كم مرة اشترى (F)، وكم صرف عندنا (M)."],
        ["R — آخر شراء", "كل ما كان شراءه أقرب، درجته أعلى."],
        ["F — كم مرة", "كل ما طلباته أكثر، درجته أعلى."],
        ["M — كم صرف", "كل ما إنفاقه أعلى، درجته أعلى."],
        ["الدرجة من 1 لـ 5", "نرتّب عملاء كل متجر على ٥ مستويات (١ الأقل، ٥ الأعلى). نحسبها لكل متجر لحاله، ولكل فئة (شركات/أفراد) لحالها — عشان تقارن نفسه بنفسه."]
      ]},
      { h: "الشرائح — مين هو العميل؟", items: [
        ["الأبطال", "أفضل عملائك: يشترون كثير وقريب وبقيمة عالية. كافئهم واطلب منهم يرشّحونك."],
        ["الأوفياء / أوفياء محتملين", "يكرّرون الشراء بشكل زين — كبّر قيمتهم بعروض مكمّلة."],
        ["عملاء جدد", "أول مرة يشترون — رحّب فيهم واهتم بأول تجربة."],
        ["معرّضين للخطر / ما نبي نخسرهم", "كانوا نشيطين وبدؤوا يبعدون — لحّقهم بعرض قبل ما يروحون."],
        ["خاملين / مفقودين", "بعيدين من زمان — حملة إرجاع بسيطة، أو لا تصرف عليهم كثير."]
      ]},
      { h: "دورة الحياة وحالة العميل", items: [
        ["جدد ← أساسيين ← متراجعين ← منسحبين", "وين وصل العميل: أول طلب جديد، ثم متكرر نشيط، ثم بدأ يهدأ، ثم طوّل غيبته."],
        ["نشط / معرّض للخطر / منسحب", "على حسب كم صار له ما طلب. النوافذ الزمنية نقدر نضبطها، وهي أوسع لعملاء الشركات لأن دورتهم أطول."]
      ]},
      { h: "شركات ولا أفراد؟ (B2B / B2C) — هذا أهم تقسيم", items: [
        ["كيف نفرّق؟", "نعتبره (شركة) إذا أي طلب له فيه رقم ضريبي سعودي صحيح (١٥ رقم يبدأ وينتهي بـ٣) أو اسم منشأة. وإذا ما فيه، نشوف متوسط طلبه — إذا ≥ الحد المحدد (افتراضيًا ٢٠٠٠ ريال) نعتبره شركة، وإلا فهو (فرد)."],
        ["ليش نفصلهم؟", "المقاول يشتري بكميات وبشكل مختلف عن المستهلك العادي. نقيس كل فئة ضمن مجموعتها فقط، عشان «بطل الشركات» يتقارن بالشركات مو بالأفراد."]
      ]},
      { h: "المبيعات والطلبات — وش نحتسب؟", items: [
        ["مؤكدة", "طلبات مدفوعة/قيد التنفيذ — هي اللي تتحسب في المبيعات وفي RFM."],
        ["ملغاة/مرتجعة", "ما تتحسب في المبيعات، ونعرضها كعدد لحاله."],
        ["بانتظار الدفع", "ما اكتملت — نستبعدها من المبيعات (عشان الأرقام تكون حقيقية)."],
        ["عملاء جدد", "اللي سجّلوا حساباتهم خلال الفترة المختارة."]
      ]},
      { h: "السلال المتروكة والمدفوعات الفاشلة", items: [
        ["السلال المتروكة", "سلات لعملاء مسجّلين ما كمّلوا الطلب (آخر ٢٨ يوم) — تقدر ترجعهم."],
        ["المدفوعات الفاشلة", "محاولات دفع انلغت وما اكتملت، مع طريقة الدفع وعدد المحاولات لكل عميل. القيمة المعروضة = متوسط المحاولة (قيمة الطلب اللي حاول يدفعه، مو مجموع المحاولات). أولوية تواصل عشان ترجع البيعة."]
      ]},
      { h: "رحلة العميل عبر المتاجر", items: [
        ["الفكرة", "المتاجر الثلاثة تمثّل مراحل المشروع: مواد البناء ← الإضاءة ← التشطيب. نعرف وين وصل العميل في رحلته."],
        ["الاستخدام", "نعرف مين انتقل للمرحلة الجاية ومين وقف، ونعطيك قائمة عملاء جاهزين تستهدفهم بالمنتجات التالية — تقدر تضغط على العميل وتروح لحسابه في سلة."]
      ]},
      { h: "الفترة الزمنية", items: [
        ["الفلتر", "يتحكّم بكل أرقام المبيعات والتصنيفات والتوزيع الجغرافي. الافتراضي: آخر سنة."],
        ["لقطة العملاء", "الشرائح ودورة الحياة تعطيك الوضع الحالي وما تتغيّر بالفلتر (لأنها لحظية بطبيعتها)."]
      ]},
      { h: "كل كم تتحدّث اللوحة؟", items: [
        ["تلقائيًا كل ليلة", "تتحدّث كل يوم الساعة ٢:٠٠ صباحًا بتوقيت غرينتش (≈ ٥:٠٠ فجرًا بتوقيت السعودية) — نسحب الطلبات والمنتجات والسلال والمدفوعات من سلة ونعيد الحساب."],
        ["تعرض آخر نسخة محفوظة", "اللوحة سريعة لأنها تقرأ آخر نسخة محسوبة ومخزّنة، وما تنادي سلة عند كل فتح. لو التحديث ما خلص بعد، تشتغل على آخر بيانات وتظهر لك إنها قيد التحديث."]
      ]}
    ],

    /* 7c) ──────── CALENDAR — Saudi events & sales-focus opportunities (calendar.html)
       Hijri-based dates are approximate (moon sighting) → approx:true. stores = which of
       your stores benefits most. focus = the recommended play. lead = days to start prep. */
    CALENDAR: {
      year: 2026,
      title: "تقويم المناسبات وفرص المبيعات — السعودية ٢٠٢٦",
      sub: "أبرز المناسبات الوطنية والدينية ومواسم التسوّق، وما الذي نركّز عليه لكل متجر لزيادة المبيعات",
      back: "← العودة للوحة",
      types: {
        national:  { ar: "وطني",        color: "#34d399" },
        religious: { ar: "ديني / موسمي", color: "#7c5cff" },
        shopping:  { ar: "تسوّق",        color: "#fb923c" },
        seasonal:  { ar: "موسمي",        color: "#4f8cff" }
      },
      labels: { focus: "التركيز المقترح", lead: "ابدأ التجهيز قبل", days: "يومًا", approx: "تاريخ تقريبي (يعتمد على الرؤية)", upcoming: "قادمة", passed: "انتهت", stores: "المتاجر المستفيدة", monthFmt: ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"] },
      events: [
        { date: "2026-02-18", name: "بداية رمضان", type: "religious", approx: true, stores: ["LIGHTING","HATCH","BUILD_STATION"], lead: 21, focus: "ذروة تجهيز المنزل قبل رمضان: إضاءة المجالس والفوانيس، لمسات المطابخ والضيافة. أطلق الحملات مبكرًا." },
        { date: "2026-02-22", name: "يوم التأسيس", type: "national", stores: ["LIGHTING","HATCH"], lead: 10, focus: "ثيم تراثي/وطني للإضاءة والديكور مع عروض محدودة المدة." },
        { date: "2026-03-11", name: "يوم العلم", type: "national", stores: ["LIGHTING","HATCH"], lead: 5, focus: "حملة رمزية بثيم وطني أخضر." },
        { date: "2026-03-20", name: "عيد الفطر", type: "religious", approx: true, stores: ["HATCH","LIGHTING"], lead: 12, focus: "تجديد المنزل قبل العيد، الضيافة والهدايا واللمسات الأخيرة." },
        { date: "2026-05-27", name: "عيد الأضحى", type: "religious", approx: true, stores: ["HATCH","LIGHTING"], lead: 12, focus: "تجهيز المنزل للاستقبال والضيافة." },
        { date: "2026-07-01", name: "موسم الصيف (الترميم والتبريد)", type: "seasonal", stores: ["BUILD_STATION","LIGHTING"], lead: 14, focus: "موسم المشاريع والترميم، الإضاءة الخارجية وحلول التبريد. استهدف عملاء «مرحلة البناء»." },
        { date: "2026-08-20", name: "العودة للمدارس", type: "shopping", stores: ["HATCH","LIGHTING"], lead: 14, focus: "غرف ومكاتب الطلاب وإضاءة المهام." },
        { date: "2026-09-23", name: "اليوم الوطني السعودي", type: "national", stores: ["BUILD_STATION","LIGHTING","HATCH"], lead: 18, focus: "أكبر مناسبة وطنية: ثيم أخضر، إضاءة وديكور، عروض قوية عبر المتاجر الثلاثة. جهّز المخزون مبكرًا." },
        { date: "2026-11-11", name: "11.11", type: "shopping", stores: ["LIGHTING","HATCH"], lead: 10, focus: "عروض مبكرة تمهيدًا للجمعة البيضاء." },
        { date: "2026-11-27", name: "الجمعة البيضاء (White Friday)", type: "shopping", stores: ["BUILD_STATION","LIGHTING","HATCH"], lead: 30, focus: "أكبر موسم تسوّق في السنة — خصومات عميقة. جهّز المخزون واللوجستيات والإعلانات قبل شهر، واستهدف السلال المتروكة والمدفوعات الفاشلة." },
        { date: "2026-12-31", name: "نهاية العام والتصفيات", type: "seasonal", stores: ["HATCH","LIGHTING"], lead: 14, focus: "تصفية نهاية العام وتجديد المنزل قبل السنة الجديدة." }
      ]
    },

    /* 8) ───────── UI — all on-screen Arabic text ─────────────────────────────
       Change wording here without touching the dashboard code. */
    UI: {
      title: "تجزئة العملاء ورحلتهم",
      subtitle: "شرائح RFM · دورة الحياة · مراحل الرحلة · تفعيل الحملات — عبر متاجر سلة",
      live: "بيانات مباشرة", sample: "بيانات تجريبية", offline: "تجريبي (الواجهة الخلفية غير مفعّلة)",
      updated: "آخر تحديث",
      preparing: "جاري تجهيز أحدث البيانات من سلة — يُعرض آخر تحديث محفوظ",
      bannerSample: "أنت تشاهد بيانات تجريبية. اضبط مفاتيح الـ Tokens في إعدادات الاستضافة لعرض بيانات المتجر الحقيقية (انظر README).",
      ordersScanned: "طلب تم فحصه",
      glossary: { toggle: "كيف نقرأ هذه اللوحة؟", title: "دليل قراءة اللوحة (للفريق)", calendar: "📅 تقويم المناسبات" },
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
      kpiSalesLabel: "أداء المبيعات",
      kpiSnapshotLabel: "الوضع الحالي للعملاء — لقطة لحظية (لا تتأثر بفلتر الفترة)",
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
        allTime: "آخر سنة",
        trendsTitle: "المبيعات",
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
      /* #3b — failed electronic payments (from the Salla transactions log) */
      failed: {
        title: "أعلى العملاء بمدفوعات فاشلة (فرص استرداد)",
        sub: "عملاء تكرر فشل دفعهم خلال آخر ١٥ يومًا · عميل واحد لكل صف مع عدد المحاولات · أعلى ١٠ بإجمالي القيمة الفاشلة",
        count: "محاولات فاشلة (١٥ يومًا)",
        customers: "عملاء متأثرون",
        value: "إجمالي القيمة المعرّضة",
        cols: { customer: "العميل", value: "قيمة الطلب (متوسط المحاولة)", attempts: "المحاولات", method: "آخر طريقة دفع", date: "آخر محاولة", salla: "فتح في سلة" },
        statusFailed: "ملغية", openLog: "السجل ↗", view: "عرض العميل", guest: "زائر",
        logUrl: "https://s.salla.sa/log/transactions",
        needScope: "يتطلب صلاحية transactions.read على تطبيق سلة لهذا المتجر."
      },
      /* #4 — cross-store customer journey */
      journey2: {
        title: "رحلة العميل عبر المتاجر",
        sub: "مطابقة العملاء عبر المتاجر الثلاثة (عبر بصمة الجوال) — في أي مرحلة هم الآن، ومن جاهز للخطوة التالية",
        matchedNote: (n, m, v) => `طُوبق ${n} عميلًا عبر المتاجر · ${m} اشتروا من أكثر من متجر بقيمة ${v}.`,
        kStages: "مراحل المشروع", kMatched: "عملاء مُطابَقون", kMulti: "متعدّد المتاجر", kValue: "قيمتهم",
        stageCol: "المرحلة", reachCol: "وصلوا إليها", hereCol: "متوقّفون هنا", valueCol: "قيمتهم",
        convTitle: "معدّل الانتقال بين المراحل",
        convLine: (from, to) => `ممن وصلوا «${from}» انتقلوا إلى «${to}»`,
        recoTitle: "فرص الترقية — عملاء جاهزون للمرحلة التالية الآن",
        recoLine: (n, store, val) => `${n} عميلًا جاهزون للانتقال إلى «${store}» · قيمتهم ${val}`,
        candTitle: "أبرز العملاء المرشّحين (اضغط لعرض العميل والانتقال إلى سلة)",
        candCols: { customer: "العميل", store: "آخر متجر", value: "قيمة العميل" },
        coverageNote: "القائمة قابلة للتنفيذ — اضغط على أي عميل ليفتح حسابه مباشرة في لوحة سلة.",
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
      footer: ""
    }
  };
  return CONFIG;
});
