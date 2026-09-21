import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
  expiresAtFromNow,
  generateOpaqueToken,
  hashToken,
  isAllowedRedirectUri,
  isExpired,
  verifyPkceChallenge,
} from "../src/mcp-auth-crypto.mjs";

test("generateOpaqueToken produces distinct, sufficiently long random tokens", () => {
  const a = generateOpaqueToken();
  const b = generateOpaqueToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, "32 random bytes base64url-encoded should be well over 40 chars");
});

test("hashToken is deterministic and never returns the input unchanged", () => {
  const token = generateOpaqueToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
  assert.equal(hashToken(token).length, 64, "sha256 hex digest is 64 chars");
});

// Independently reproduces the RFC 7636 algorithm a real client would run,
// rather than reusing verifyPkceChallenge's own internals — this is what
// actually proves interoperability, not just internal self-consistency.
function realClientPkcePair() {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, within RFC bounds
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

test("verifyPkceChallenge accepts a genuine RFC 7636 S256 pair", () => {
  const { verifier, challenge } = realClientPkcePair();
  assert.equal(verifyPkceChallenge({ verifier, challenge, method: "S256" }), true);
});

test("verifyPkceChallenge rejects a mismatched verifier", () => {
  const { challenge } = realClientPkcePair();
  const wrongVerifier = randomBytes(32).toString("base64url");
  assert.equal(verifyPkceChallenge({ verifier: wrongVerifier, challenge, method: "S256" }), false);
});

test("verifyPkceChallenge rejects the plain method outright, even with matching strings", () => {
  const value = "same-string-used-as-both-verifier-and-challenge-1234567890";
  assert.equal(verifyPkceChallenge({ verifier: value, challenge: value, method: "plain" }), false);
});

test("verifyPkceChallenge rejects a verifier outside RFC 7636's length bounds", () => {
  const { challenge } = realClientPkcePair();
  assert.equal(verifyPkceChallenge({ verifier: "too-short", challenge, method: "S256" }), false);
  assert.equal(verifyPkceChallenge({ verifier: "x".repeat(200), challenge, method: "S256" }), false);
});

test("verifyPkceChallenge rejects malformed or missing input without throwing", () => {
  assert.equal(verifyPkceChallenge({ verifier: undefined, challenge: "x".repeat(43), method: "S256" }), false);
  assert.equal(verifyPkceChallenge({ verifier: "x".repeat(43), challenge: undefined, method: "S256" }), false);
  assert.equal(verifyPkceChallenge({}), false);
});

test("isAllowedRedirectUri is exact-match only, not prefix or pattern matching", () => {
  const allowedUris = ["https://agent.example.com/oauth/callback"];
  assert.equal(isAllowedRedirectUri({ redirectUri: "https://agent.example.com/oauth/callback", allowedUris }), true);
  assert.equal(
    isAllowedRedirectUri({ redirectUri: "https://agent.example.com/oauth/callback/../evil", allowedUris }),
    false,
  );
  assert.equal(
    isAllowedRedirectUri({ redirectUri: "https://agent.example.com/oauth/callback?extra=1", allowedUris }),
    false,
    "query string appended must not match — exact string only",
  );
  assert.equal(
    isAllowedRedirectUri({ redirectUri: "https://attacker.com/oauth/callback", allowedUris }),
    false,
  );
  assert.equal(isAllowedRedirectUri({ redirectUri: "https://agent.example.com/oauth/callback", allowedUris: [] }), false);
});

test("isExpired correctly straddles the expiry instant", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  assert.equal(isExpired("2026-09-21T11:59:59.000Z", now), true);
  assert.equal(isExpired("2026-09-21T12:00:00.000Z", now), true, "exactly at expiry counts as expired, not one tick of grace");
  assert.equal(isExpired("2026-09-21T12:00:01.000Z", now), false);
  assert.equal(isExpired(null, now), true, "no expiry recorded is treated as expired, never as unlimited");
});

test("expiresAtFromNow uses the named TTL constants correctly", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  assert.equal(expiresAtFromNow(AUTHORIZATION_CODE_TTL_SECONDS, now), "2026-09-21T12:05:00.000Z");
  assert.equal(expiresAtFromNow(ACCESS_TOKEN_TTL_SECONDS, now), "2026-09-21T13:00:00.000Z");
});
