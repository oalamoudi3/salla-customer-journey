/* =============================================================================
   refresh-scheduled.js — Netlify SCHEDULED function (cron set in netlify.toml).
   Scheduled functions have only a 30s budget and cannot themselves be background
   functions, so this one does no heavy work: it kicks off the background refresh
   (which has the ~15-min budget), forwarding the refresh key, and returns.
   ============================================================================= */
exports.handler = async (event) => {
  // Netlify's cron invocation sends a JSON body with `next_run`. Allow that; for any
  // other (external HTTP) caller require the refresh key, so the endpoint can't be
  // used to trigger pulls at will.
  let scheduled = false;
  try { scheduled = !!(event && event.body && JSON.parse(event.body).next_run); } catch (_) {}
  const hdr = (event && event.headers) || {};
  const key = hdr["x-refresh-key"] || hdr["X-Refresh-Key"] || "";
  if (!scheduled && (!process.env.REFRESH_KEY || key !== process.env.REFRESH_KEY)) {
    return { statusCode: 401, body: "unauthorized" };
  }

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  try {
    // Background functions return 202 immediately; we don't await the pull itself.
    await fetch(`${base}/.netlify/functions/refresh-background`, {
      method: "POST",
      headers: { "x-refresh-key": process.env.REFRESH_KEY || "" }
    });
    return { statusCode: 200, body: "triggered refresh-background" };
  } catch (e) {
    return { statusCode: 500, body: "trigger failed: " + String((e && e.message) || e) };
  }
};
