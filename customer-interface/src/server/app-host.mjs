// The dashboard's public address (2026-10-25: moving from utplava.vercel.app
// to app.utplava.dev). One setting decides it: CANONICAL_APP_HOST on the
// `utplava` Vercel project. Until it's set, nothing changes.

export const LEGACY_APP_HOSTS = new Set(["utplava.vercel.app"]);

// GitHub delivers webhooks to the address saved in the GitHub App and does
// not follow redirects, so the webhook must keep answering on the old host.
const NEVER_REDIRECT_PATHS = ["/api/github/webhook"];

export function canonicalAppHost(env = process.env) {
  const host = String(env.CANONICAL_APP_HOST || "").trim().toLowerCase();
  return /^[a-z0-9.-]+$/.test(host) ? host : null;
}

export function mcpIssuerUrl(env = process.env) {
  if (env.MCP_ISSUER_URL) return env.MCP_ISSUER_URL;
  const canonical = canonicalAppHost(env);
  if (canonical) return `https://${canonical}`;
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

// Where to send a request that arrived on the old address, or null to serve
// it as-is. Only exact legacy hosts move (preview deployments keep working).
// `host` is the Host header the visitor actually used. On Vercel the URL a
// proxy sees can carry an internal hostname, so the header is the source of
// truth (found live 2026-10-25: the redirect never fired from the URL alone).
export function legacyRedirectTarget(requestUrl, env = process.env, host = null) {
  const canonical = canonicalAppHost(env);
  if (!canonical) return null;
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  const visitedHost = String(host || url.host).toLowerCase().split(":")[0];
  if (!LEGACY_APP_HOSTS.has(visitedHost) || visitedHost === canonical) return null;
  if (NEVER_REDIRECT_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return null;
  url.protocol = "https:";
  url.hostname = canonical;
  url.port = "";
  return url.toString();
}
