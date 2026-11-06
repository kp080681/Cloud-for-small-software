import assert from "node:assert/strict";
import test from "node:test";
import { googleAuthorizationUrl, normalizeGoogleUser, createPkcePair } from "../src/server/google-oauth.mjs";
import { checkPasswordLogin, hashPassword, verifyPassword, MAX_FAILED } from "../src/server/password-login.mjs";
import { workspaceNameFor } from "../src/server/sign-in.mjs";

test("Google sign-in asks only for basic profile, uses PKCE, and keys on the stable id", () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43 && challenge.length === 43);
  const url = googleAuthorizationUrl({ state: "s", redirectUri: "https://app.utplava.dev/api/auth/google/callback", codeChallenge: challenge, env: { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "x" } });
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const user = normalizeGoogleUser({ sub: "1234567890", email: "Asha@Example.com", email_verified: true, name: "Asha", picture: "https://x/y.png" });
  assert.deepEqual(user, { provider: "google", providerAccountId: "1234567890", login: "asha@example.com", displayName: "Asha", avatarUrl: "https://x/y.png" });
  assert.throws(() => normalizeGoogleUser({ sub: "1234567890", email: "a@b.c", email_verified: false }), /not verified/);
  assert.throws(() => normalizeGoogleUser({ email: "a@b.c", email_verified: true }), /incomplete/);
  assert.equal(workspaceNameFor(user), "Asha workspace");
  assert.equal(workspaceNameFor({ provider: "password", login: "reviewer@utplava.dev", displayName: "" }), "reviewer workspace");
});

test("passwords are stored as scrypt hashes and checked in constant time", async () => {
  const hash = await hashPassword("correct horse");
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!hash.includes("correct"));
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

function loginDb(row) {
  const updates = [];
  return {
    updates,
    async query(sql, params) {
      if (sql.includes("FROM password_logins pl")) return { rows: row && params[0] === row.email ? [row] : [] };
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  };
}

test("email login works only for created accounts, and counts wrong tries", async () => {
  const row = {
    email: "reviewer@utplava.dev", customer_identity_id: "ci", password_hash: await hashPassword("pw-123"),
    failed_attempts: 0, locked_until: null, id: "ci", provider: "password", provider_account_id: "reviewer@utplava.dev",
    login: "reviewer@utplava.dev", display_name: "Reviewer", avatar_url: null,
  };
  const db = loginDb(row);
  const ok = await checkPasswordLogin(db, { email: " Reviewer@Utplava.dev ", password: "pw-123" });
  assert.equal(ok.id, "ci");
  assert.match(db.updates.at(-1), /failed_attempts = 0/);
  await assert.rejects(checkPasswordLogin(db, { email: "reviewer@utplava.dev", password: "nope" }), { code: "PASSWORD_LOGIN_FAILED" });
  assert.match(db.updates.at(-1), /failed_attempts \+ 1/);
  await assert.rejects(checkPasswordLogin(loginDb(null), { email: "nobody@x.y", password: "pw" }), { code: "PASSWORD_LOGIN_FAILED" });
  await assert.rejects(
    checkPasswordLogin(loginDb({ ...row, locked_until: new Date(Date.now() + 60_000) }), { email: row.email, password: "pw-123" }),
    { code: "PASSWORD_LOGIN_LOCKED" },
  );
  assert.equal(MAX_FAILED, 10);
});
