import assert from "node:assert/strict";
import test from "node:test";
import {
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
