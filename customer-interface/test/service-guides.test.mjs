import assert from "node:assert/strict";
import test from "node:test";
import { checkServiceValue, serviceFollowUps, serviceGuideFor } from "../src/shared/service-guides.mjs";

const warnings = (key, value) => checkServiceValue(key, value).filter((n) => n.level === "warning").map((n) => n.message);

test("known service settings get plain-English help, public prefixes included", () => {
  assert.equal(serviceGuideFor("STRIPE_SECRET_KEY").serviceName, "Stripe");
  assert.equal(serviceGuideFor("NEXT_PUBLIC_SUPABASE_URL").serviceName, "Supabase");
  assert.equal(serviceGuideFor("VITE_SUPABASE_ANON_KEY").secret, false);
  assert.equal(serviceGuideFor("MY_OWN_SETTING"), null);
});

test("a secret in a browser-visible setting is flagged, a publishable key is not", () => {
  assert.ok(serviceGuideFor("NEXT_PUBLIC_STRIPE_SECRET_KEY").exposedWarning);
  assert.ok(serviceGuideFor("VITE_SUPABASE_SERVICE_ROLE_KEY").exposedWarning);
  assert.ok(serviceGuideFor("NEXT_PUBLIC_MY_API_SECRET").exposedWarning, "unknown secret-looking names are flagged too");
  assert.equal(serviceGuideFor("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY").exposedWarning, null);
  assert.equal(serviceGuideFor("STRIPE_SECRET_KEY").exposedWarning, null);
});

test("pasted values are checked for the common mix-ups", () => {
  assert.deepEqual(warnings("STRIPE_SECRET_KEY", "sk_live_abc"), []);
  assert.match(warnings("STRIPE_SECRET_KEY", "pk_live_abc")[0], /publishable/);
  assert.match(warnings("STRIPE_PUBLISHABLE_KEY", "sk_live_abc")[0], /secret key/);
  assert.match(warnings("RAZORPAY_KEY_SECRET", "rzp_live_abc")[0], /key ID/);
  assert.match(warnings("OPENAI_API_KEY", "sk-ant-abc")[0], /Anthropic/);
  assert.match(warnings("RESEND_API_KEY", "hello")[0], /doesn't look like a Resend key/);
  assert.match(warnings("SUPABASE_URL", "https://example.com")[0], /supabase\.co/);
  assert.deepEqual(warnings("SUPABASE_URL", "https://abcd.supabase.co"), []);
  assert.match(warnings("ANY_SETTING", " value")[0], /space/);
  assert.match(warnings("ANY_SETTING", "KEY=value")[0], /whole line/);
  assert.match(warnings("ANY_SETTING", '"value"')[0], /quote/);
  assert.deepEqual(checkServiceValue("ANY_SETTING", ""), []);
});

test("test keys get a gentle note, not a warning", () => {
  const notes = checkServiceValue("STRIPE_SECRET_KEY", "sk_test_abc");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "note");
});

test("each detected service gets its one follow-up step, once", () => {
  const steps = serviceFollowUps(["STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "OTHER"]);
  assert.deepEqual(steps.map((s) => s.service), ["stripe", "supabase"]);
  assert.deepEqual(serviceFollowUps([]), []);
});
