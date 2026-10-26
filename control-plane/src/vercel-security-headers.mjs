// Safe browser security headers for every Utplava app (2026-10-26).
//
// Applied as a Vercel project-level routing rule (CDN level, no file
// changes, works for both git-source and file-upload deployments). Chosen so
// they can't break an app:
// - X-Content-Type-Options: nosniff and Referrer-Policy:
//   strict-origin-when-cross-origin are "set" (the referrer value is the
//   browser default anyway).
// - The Content-Security-Policy is APPENDED, never set: if the app sends its
//   own policy, browsers enforce both, so ours can only add restrictions and
//   never loosen the app's. It deliberately doesn't restrict scripts (that
//   needs per-app knowledge); it stops other sites framing the app
//   (clickjacking), plugins, and <base> hijacking.
// HSTS is already sent by Vercel for every HTTPS host.

export const SECURITY_HEADERS_RULE_ID = "utplava-security-headers";
export const UTPLAVA_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

export function securityHeadersRule() {
  return {
    id: SECURITY_HEADERS_RULE_ID,
    name: "Utplava security headers",
    description: "Added by Utplava: safe browser security headers for every page.",
    enabled: true,
    srcSyntax: "regex",
    route: {
      src: "^/(.*)$",
      transforms: [
        { type: "response.headers", op: "set", target: { key: "X-Content-Type-Options" }, args: "nosniff" },
        { type: "response.headers", op: "set", target: { key: "Referrer-Policy" }, args: "strict-origin-when-cross-origin" },
        { type: "response.headers", op: "append", target: { key: "Content-Security-Policy" }, args: UTPLAVA_CSP },
      ],
    },
  };
}

// Stages the rule (merged by id, so any other rules on the project are left
// alone) and promotes that version to production. `request(path, init)` is
// the caller's Vercel API client; `teamQuery` builds ?teamId=.
export async function ensureSecurityHeaders({ projectId, request, teamQuery = () => "" }) {
  if (!projectId) throw new Error("projectId required");
  const base = `/v1/projects/${encodeURIComponent(projectId)}/routes`;
  const staged = await request(`${base}${teamQuery()}`, {
    method: "PUT",
    body: JSON.stringify({ routes: [securityHeadersRule()] }),
  });
  const versionId = staged?.version?.id;
  if (!versionId) throw new Error("Vercel returned no routing version id");
  const promoted = await request(`${base}/versions${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify({ id: versionId, action: "promote" }),
  });
  return { versionId, live: promoted?.version?.isLive ?? null };
}
