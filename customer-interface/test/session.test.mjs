import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_TTL_MS,
  assertAuthenticatedSession,
  publicSession,
  sealSession,
  unsealSession,
} from "../src/server/session.mjs";

const secret = "0123456789abcdef0123456789abcdef";

test("authenticated session resolution uses sealed server-side data", async () => {
  const sealed = await sealSession(
    {
      customerId: "identity-1",
      provider: "github",
      login: "founder",
      name: "Founder",
      avatarUrl: "https://avatars.example/founder.png",
    },
    secret,
  );

  const session = await unsealSession(sealed, secret);
  assert.equal(session.customerId, "identity-1");
  assert.equal(session.provider, "github");
  assert.equal(session.login, "founder");
});

test("a session unsealed well within its 7-day lifetime is still valid — regression guard so the TTL fix below doesn't accidentally reject fresh sessions", async () => {
  const sealed = await sealSession({ customerId: "identity-1", provider: "github", login: "founder" }, secret);
  const almostSevenDaysLater = Date.now() + SESSION_TTL_MS - 60_000;
  const session = await unsealSession(sealed, secret, almostSevenDaysLater);
  assert.equal(session.customerId, "identity-1");
});

test("a session past its 7-day lifetime is rejected — regression test for a bug an independent review (Opus 5.5) found: issuedAt was written into every session but never actually checked, and Iron.defaults has no expiry at all, so a stolen session cookie stayed valid forever", async () => {
  const sealed = await sealSession({ customerId: "identity-1", provider: "github", login: "founder" }, secret);
  const eightDaysLater = Date.now() + SESSION_TTL_MS + 24 * 60 * 60 * 1000;
  const session = await unsealSession(sealed, secret, eightDaysLater);
  assert.equal(session, null);
});

test("unauthenticated customer API access is rejected by the shared session guard", () => {
  assert.throws(() => assertAuthenticatedSession(null), {
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
  });
});

test("customer session response exposes no provider secrets or internal auth fields", () => {
  const safe = publicSession({
    customerId: "identity-1",
    provider: "github",
    providerAccountId: "123456",
    login: "founder",
    name: "Founder",
    avatarUrl: null,
    accessToken: "must-not-leak",
    clientSecret: "must-not-leak",
  });

  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("providerAccountId"), false);
  assert.equal(serialized.includes("accessToken"), false);
  assert.equal(serialized.includes("clientSecret"), false);
  assert.equal(serialized.includes("must-not-leak"), false);
});
