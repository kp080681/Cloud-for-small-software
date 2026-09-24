import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// Opaque bearer credentials (authorization codes, access tokens, refresh
// tokens) are all generated the same way: 32 random bytes, base64url. Never
// derived from anything guessable (customer id, timestamp, etc).
export function generateOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

// What's ever stored in the database for a code or token — a SHA-256 hex
// digest, never the plaintext. Same principle as password/secret storage:
// nothing here needs to be reversible, so nothing here should be
// reversible, not even by an Utplava operator with database access.
export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// PKCE S256 verification (RFC 7636). Deliberately supports only S256, never
// the "plain" method RFC 7636 also technically allows — "plain" means the
// challenge equals the verifier in cleartext, which defeats the entire
// point of PKCE (protecting the code in transit) and exists in the spec
// only for constrained clients that can't compute SHA-256, which no MCP
// client calling Utplava has any excuse to be.
//
// Uses a constant-time comparison — this is genuinely secret material being
// checked, unlike a short-lived CSRF nonce, so a timing side-channel here
// is worth closing properly.
export function verifyPkceChallenge({ verifier, challenge, method = "S256" }) {
  if (method !== "S256") return false;
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false; // RFC 7636 length bounds
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const computedBuffer = Buffer.from(computed);
  const challengeBuffer = Buffer.from(challenge);
  if (computedBuffer.length !== challengeBuffer.length) return false;
  return timingSafeEqual(computedBuffer, challengeBuffer);
}

// Redirect URI validation is exact-match only, never prefix or pattern
// matching — allowing "close enough" redirect URIs is one of the most
// common real-world OAuth open-redirect vulnerabilities. A client's
// allowed URIs are a fixed allowlist (mcp_clients.redirect_uris); the URI
// presented at both the authorization request and the token exchange must
// match one of them exactly, and must match each other exactly too (that
// second check lives in exchangeAuthorizationCode, not here).
export function isAllowedRedirectUri({ redirectUri, allowedUris }) {
  if (typeof redirectUri !== "string" || !Array.isArray(allowedUris)) return false;
  return allowedUris.includes(redirectUri);
}

export function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

// Lifetimes as named constants rather than magic numbers scattered through
// the orchestration functions — also makes the security tradeoffs (why a
// code lives 5 minutes, why an access token lives 1 hour) visible in one
// place rather than implicit in arithmetic.
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
// Absolute ceiling on one authorization grant, however often it refreshes —
// without this, each rotation issues a fresh 30-day refresh token, so an
// actively-used grant never actually expired. An independent review
// (Opus 5.5) added this after noting REFRESH_TOKEN_TTL_SECONDS alone only
// bounds a single token, not the grant's total lifetime.
export const TOKEN_FAMILY_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export function expiresAtFromNow(ttlSeconds, now = new Date()) {
  return new Date(new Date(now).getTime() + ttlSeconds * 1000).toISOString();
}
