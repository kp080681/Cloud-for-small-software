// Cross-site request guard (2026-10-31). Customer apps are served from
// <name>.utplava.dev, which browsers treat as the SAME SITE as the dashboard
// (app.utplava.dev), so SameSite=Lax session cookies do not stop a page on a
// customer app from sending a state-changing request to the dashboard with a
// signed-in visitor's cookies. Every cookie-authenticated write must come
// from the dashboard's own origin.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Routes that are called by other origins on purpose and never act on a
// session cookie: GitHub webhooks (signed), the MCP endpoints (bearer tokens
// and OAuth client registration), and the public app check used by the
// utplava.dev website.
const CROSS_ORIGIN_ALLOWED = [
  /^\/api\/github\/webhook\/?$/,
  /^\/api\/mcp\/?$/,
  /^\/api\/mcp\/token\/?$/,
  /^\/api\/mcp\/register\/?$/,
  /^\/api\/check(\/.*)?$/,
];

function hostOf(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

// Returns null when the request may proceed, or a short reason when it must
// be refused. `requestHost` is the Host the visitor used (x-forwarded-host on
// Vercel). Requests without browser provenance headers (servers, scripts) are
// allowed: they cannot carry a victim's cookies.
export function crossSiteWriteRefusal({ method, pathname, requestHost, origin, secFetchSite }) {
  if (SAFE_METHODS.has(String(method || "").toUpperCase())) return null;
  if (!String(pathname || "").startsWith("/api/")) return null;
  if (CROSS_ORIGIN_ALLOWED.some((pattern) => pattern.test(pathname))) return null;

  const fetchSite = String(secFetchSite || "").toLowerCase();
  if (fetchSite) {
    return fetchSite === "same-origin" || fetchSite === "none" ? null : `sec-fetch-site:${fetchSite}`;
  }
  if (origin && origin !== "null") {
    const host = String(requestHost || "").toLowerCase();
    return hostOf(origin) === host ? null : "origin-mismatch";
  }
  if (origin === "null") return "origin-null";
  return null;
}
