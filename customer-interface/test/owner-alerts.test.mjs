import test from "node:test";
import assert from "node:assert/strict";
import { alertFirstDeployStarted, alertNewSignup, sendOwnerAlert } from "../src/server/owner-alerts.mjs";

const env = { RESEND_API_KEY: "re_test", OWNER_ALERT_EMAIL: "owner@example.com" };

function capture(ok = true, status = 200) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status };
  };
  return { sent, fetchImpl };
}

class FakeDb {
  constructor({ earlierDeploy = false } = {}) {
    this.earlierDeploy = earlierDeploy;
  }
  async query(text) {
    if (text.includes("FROM customer_identities WHERE id")) {
      return { rows: [{ login: "asha-dev", display_name: "Asha", total_users: 7 }] };
    }
    if (text.includes("FROM deployments")) return { rowCount: this.earlierDeploy ? 1 : 0, rows: [] };
    if (text.includes("FROM apps a")) return { rows: [{ name: "shop", full_name: "asha-dev/shop" }] };
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

test("alerts are off until both env vars are set", async () => {
  const { sent, fetchImpl } = capture();
  assert.deepEqual(await sendOwnerAlert({ subject: "s", text: "t" }, { env: {}, fetchImpl }), { sent: false, reason: "not_configured" });
  assert.deepEqual(
    await sendOwnerAlert({ subject: "s", text: "t" }, { env: { RESEND_API_KEY: "x" }, fetchImpl }),
    { sent: false, reason: "not_configured" },
  );
  assert.equal(sent.length, 0);
});

test("a sign-up alert names the person and links their GitHub", async () => {
  const { sent, fetchImpl } = capture();
  assert.deepEqual(await alertNewSignup(new FakeDb(), { customerId: "c1" }, { env, fetchImpl }), { sent: true });
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].init.headers.Authorization, "Bearer re_test");
  assert.deepEqual(sent[0].body.to, ["owner@example.com"]);
  assert.equal(sent[0].body.subject, "New Utplava sign-up: Asha (@asha-dev)");
  assert.match(sent[0].body.text, /https:\/\/github\.com\/asha-dev/);
  assert.match(sent[0].body.text, /Total users so far: 7/);
});

test("only a workspace's first deploy sends an alert", async () => {
  const first = capture();
  await alertFirstDeployStarted(new FakeDb(), { customerId: "c1", workspaceId: "w", appId: "a", deploymentId: "d" }, { env, fetchImpl: first.fetchImpl });
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0].body.text, /github\.com\/asha-dev\/shop/);

  const later = capture();
  const result = await alertFirstDeployStarted(
    new FakeDb({ earlierDeploy: true }),
    { customerId: "c1", workspaceId: "w", appId: "a", deploymentId: "d" },
    { env, fetchImpl: later.fetchImpl },
  );
  assert.deepEqual(result, { sent: false, reason: "not_first" });
  assert.equal(later.sent.length, 0);
});

test("a failing mail service never throws", async () => {
  const refused = capture(false, 403);
  assert.deepEqual(await sendOwnerAlert({ subject: "s", text: "t" }, { env, fetchImpl: refused.fetchImpl }), { sent: false, reason: "http_403" });
  const broken = async () => {
    throw new TypeError("network down");
  };
  assert.deepEqual(await sendOwnerAlert({ subject: "s", text: "t" }, { env, fetchImpl: broken }), { sent: false, reason: "error" });
  const brokenDb = { query: async () => { throw new Error("db down"); } };
  assert.deepEqual(await alertNewSignup(brokenDb, { customerId: "c" }, { env, fetchImpl: refused.fetchImpl }), { sent: false, reason: "error" });
});
