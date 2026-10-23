// Dynamic client registration for Utplava's MCP server (RFC 7591), added
// 2026-10-23 so any standard MCP client (Claude, Claude Code, Cursor,
// VS Code, Windsurf) can connect without an operator registering it by
// hand first.
//
// What registration does NOT grant: anything. A registered client still
// has to send a person through GitHub sign-in and an explicit
// "Allow <name> to access <workspace>?" screen, and redirect_uri stays an
// exact-match allowlist per client. So the trust decision stays with the
// person, as with any OAuth app; the consent screen shows where the
// connection returns to, because a self-registered name proves nothing.

import { randomBytes } from "node:crypto";

export class RegistrationError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_NAME_LENGTH = 80;
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:", "chrome:", "chrome-extension:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// https anywhere; http only on loopback (RFC 8252 §7.3, native apps like
// Claude Code and VS Code); a private-use app scheme like cursor:// or
// vscode:// (RFC 8252 §7.1). Never a fragment, never a browser-dangerous
// scheme.
export function isAcceptableRedirectUri(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URI_LENGTH) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const scheme = url.protocol;
  if (BLOCKED_SCHEMES.has(scheme)) return false;
  if (scheme === "https:") return Boolean(url.hostname);
  if (scheme === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(scheme);
}

function cleanName(value) {
  const text = typeof value === "string" ? value : "";
  // Strip control and bidi-override characters so a name can't fake text
  // direction or line breaks on the consent screen.
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().replace(/\s+/g, " ");
  return (cleaned || "An MCP client").slice(0, MAX_NAME_LENGTH);
}

export function validateRegistrationRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RegistrationError("invalid_client_metadata", "Body must be a JSON object.");
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw new RegistrationError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  const unique = [...new Set(redirectUris)];
  if (!unique.every(isAcceptableRedirectUri)) {
    throw new RegistrationError("invalid_redirect_uri", "Each redirect_uri must be https, a loopback http address, or an app scheme, without a fragment.");
  }
  const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    throw new RegistrationError("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
  }
  const responseTypes = body.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code")) {
    throw new RegistrationError("invalid_client_metadata", "Only the code response type is supported.");
  }
  // Public clients only: PKCE (S256) is the credential. A client asking for
  // a secret-based method is registered as "none" (RFC 7591 §3.2.1 lets the
  // server replace requested values) and told so in the response.
  return {
    name: cleanName(body.client_name),
    redirectUris: unique,
    grantTypes: [...new Set(grantTypes)],
  };
}

// Coarse flood guard: registration is unauthenticated, so cap how many new
// clients can appear per hour overall. Real clients register once and reuse
// their client_id.
export const REGISTRATIONS_PER_HOUR = 300;

export async function registerMcpClient(db, body, { now = Date.now(), idFactory = () => `mcp_${randomBytes(24).toString("base64url")}` } = {}) {
  const request = validateRegistrationRequest(body);
  const recent = await db.query(`SELECT count(*)::int AS n FROM mcp_clients WHERE created_at > now() - interval '1 hour'`);
  if ((recent.rows[0]?.n ?? 0) >= REGISTRATIONS_PER_HOUR) {
    throw new RegistrationError("temporarily_unavailable", "Too many registrations right now. Try again later.", 429);
  }
  const clientId = idFactory();
  await db.query(
    `INSERT INTO mcp_clients (client_id, name, redirect_uris) VALUES ($1, $2, $3)`,
    [clientId, request.name, request.redirectUris],
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: request.name,
    redirect_uris: request.redirectUris,
    grant_types: request.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

// Sign-in hand-off: where to send someone after GitHub sign-in when they
// started from an MCP connection. Only these two in-app paths are ever
// allowed, so this can't become an open redirect.
const RETURN_PREFIXES = ["/api/mcp/authorize?", "/mcp/consent?"];
export function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 4000) return null;
  if (!RETURN_PREFIXES.some((prefix) => value.startsWith(prefix))) return null;
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  try {
    const parsed = new URL(value, "https://utplava.invalid");
    if (parsed.origin !== "https://utplava.invalid") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
