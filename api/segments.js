/* Vercel serverless function → GET /api/segments?store=BUILD_STATION[&debug=1]
   Holds the Salla token server-side (env var). Never exposes it to the browser. */
const CONFIG = require("../config.js");
const { buildSegments } = require("../lib/salla.js");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const storeKey = url.searchParams.get("store") || Object.keys(CONFIG.STORES)[0];
    const debug = url.searchParams.get("debug") === "1";
    const store = CONFIG.STORES[storeKey];
    if (!store) return res.status(400).json({ error: "unknown store", stores: Object.keys(CONFIG.STORES) });

    const token = process.env[store.tokenEnv] || "";
    const out = await buildSegments({ storeKey, token, cfg: CONFIG, debug });

    // short cache so the team can refresh without hammering Salla
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json(out);
  } catch (e) {
    const code = e.code === 401 ? 401 : 500;
    return res.status(code).json({
      error: e.code === 401 ? "Salla token rejected (expired or revoked). Refresh it — see README." : String(e.message || e),
      source: "error"
    });
  }
};
