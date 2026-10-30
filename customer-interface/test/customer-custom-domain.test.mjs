import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCustomDomain,
  connectCustomDomain,
  customDomainErrorResponse,
  removeCustomDomain,
  safeCustomDomain,
} from "../src/server/customer-custom-domain.mjs";
import { triggerCustomDomainTask } from "../src/server/customer-deployments.mjs";

class FakeDb {
  constructor({ app = { id: "app-1", workspace_id: "ws-1", has_live: true }, current = null, taken = false, uniqueViolation = false } = {}) {
    Object.assign(this, { app, current, taken, uniqueViolation, writes: [] });
  }
  async query(text, params = []) {
    if (text.includes("FROM customer_workspace_memberships m")) {
      const [customerId, workspaceId, appId] = params;
      const ok = this.app && customerId === "cust-1" && workspaceId === "ws-1" && appId === this.app.id;
      return { rows: ok ? [this.app] : [] };
    }
    if (text.includes("FROM app_custom_domains WHERE app_id = $1 AND status <> 'REMOVED'")) return { rows: this.current ? [this.current] : [] };
    if (text.includes("FROM app_custom_domains") && text.includes("LIMIT 1")) return { rowCount: this.taken ? 1 : 0, rows: [] };
    if (text.includes("workspace_rate_limit_counters")) return { rows: [{ count: 1 }] };
    if (text.startsWith("INSERT INTO app_custom_domains") || text.includes("INSERT INTO app_custom_domains")) {
      if (this.uniqueViolation) throw Object.assign(new Error("dup"), { code: "23505" });
      const row = { id: "dom-1", app_id: params[1], domain: params[2], status: "PENDING", records: [], conflicts: [] };
      this.writes.push(["insert", row]);
      return { rows: [row] };
    }
    if (text.startsWith("UPDATE app_custom_domains")) {
      this.writes.push(["update", text, params]);
      return { rows: this.current ? [{ ...this.current, check_requested_at: new Date().toISOString() }] : [] };
    }
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

function recorder() {
  const calls = [];
  return { calls, trigger: async (args) => { calls.push(args); return { id: "run_1" }; } };
}

const who = { customerId: "cust-1", workspaceId: "ws-1", appId: "app-1" };

test("connects a typed domain, normalised, and starts attaching it", async () => {
  const db = new FakeDb();
  const { calls, trigger } = recorder();
  const result = await connectCustomDomain(db, { ...who, domain: "https://WWW.MyBakery.com/", trigger });
  assert.equal(result.domain.domain, "mybakery.com");
  assert.equal(result.domain.status, "PENDING");
  assert.deepEqual(calls, [{ domainId: "dom-1", action: "attach" }]);
});

test("refuses another workspace's app, a non-live app, a taken domain and a reserved one", async () => {
  const { trigger } = recorder();
  await assert.rejects(connectCustomDomain(new FakeDb(), { ...who, workspaceId: "ws-2", domain: "a.com", trigger }), (e) => e.code === "APP_NOT_FOUND");
  await assert.rejects(connectCustomDomain(new FakeDb({ app: { id: "app-1", has_live: false } }), { ...who, domain: "a.com", trigger }), (e) => e.code === "APP_NOT_LIVE");
  await assert.rejects(connectCustomDomain(new FakeDb({ taken: true }), { ...who, domain: "a.com", trigger }), (e) => e.code === "DOMAIN_IN_USE");
  await assert.rejects(connectCustomDomain(new FakeDb({ uniqueViolation: true }), { ...who, domain: "a.com", trigger }), (e) => e.code === "DOMAIN_IN_USE");
  await assert.rejects(connectCustomDomain(new FakeDb(), { ...who, domain: "x.utplava.dev", trigger }), (e) => e.code === "DOMAIN_RESERVED");
});

test("one domain per app: the same domain again is fine, a different one is refused", async () => {
  const current = { id: "dom-1", domain: "mybakery.com", status: "NEEDS_DNS", records: [], conflicts: [] };
  const { calls, trigger } = recorder();
  const again = await connectCustomDomain(new FakeDb({ current }), { ...who, domain: "mybakery.com", trigger });
  assert.equal(again.alreadyConnected, true);
  await assert.rejects(connectCustomDomain(new FakeDb({ current }), { ...who, domain: "other.com", trigger }), (e) => e.code === "CUSTOM_DOMAIN_EXISTS");
  assert.equal(calls.length, 0);
});

test("a failed start releases the domain instead of leaving it reserved", async () => {
  const db = new FakeDb();
  const trigger = async () => { throw Object.assign(new Error("down"), { status: 502, code: "CUSTOM_DOMAIN_START_FAILED" }); };
  await assert.rejects(connectCustomDomain(db, { ...who, domain: "a.com", trigger }));
  assert.ok(db.writes.some(([kind, text]) => kind === "update" && text.includes("'REMOVED'")));
});

test("check now starts a check, and back-to-back clicks reuse it", async () => {
  const { calls, trigger } = recorder();
  const current = { id: "dom-1", domain: "mybakery.com", status: "NEEDS_DNS", records: [], conflicts: [], check_requested_at: null };
  await checkCustomDomain(new FakeDb({ current }), { ...who, trigger });
  assert.deepEqual(calls, [{ domainId: "dom-1", action: "check" }]);
  await checkCustomDomain(new FakeDb({ current: { ...current, check_requested_at: new Date().toISOString() } }), { ...who, trigger });
  assert.equal(calls.length, 1);
});

test("remove marks the domain as removing and starts the engine", async () => {
  const { calls, trigger } = recorder();
  const db = new FakeDb({ current: { id: "dom-1", domain: "mybakery.com", status: "ACTIVE" } });
  const result = await removeCustomDomain(db, { ...who, trigger });
  assert.equal(result.removing, true);
  assert.deepEqual(calls, [{ domainId: "dom-1", action: "remove" }]);
  assert.deepEqual(await removeCustomDomain(new FakeDb(), { ...who, trigger }), { removed: true });
});

test("the safe view only shows records while they're useful, and the link once live", () => {
  const row = {
    id: "d", domain: "mybakery.com", status: "NEEDS_DNS", dns_provider_key: "godaddy", dns_provider_name: "GoDaddy",
    records: [{ type: "A", name: "@", value: "76.76.21.21", fqdn: "mybakery.com", extra: "dropped" }],
    conflicts: [{ type: "A", name: "@", value: "185.1.1.1" }],
  };
  const view = safeCustomDomain(row);
  assert.equal(view.url, null);
  assert.deepEqual(Object.keys(view.records[0]).sort(), ["fqdn", "name", "purpose", "type", "value"]);
  assert.equal(view.remove.length, 1);
  assert.match(view.steps[0], /godaddy/i);
  assert.match(view.message, /GoDaddy/);
  const live = safeCustomDomain({ ...row, status: "ACTIVE" });
  assert.equal(live.url, "https://mybakery.com");
  assert.deepEqual(live.records, []);
  assert.equal(safeCustomDomain({ ...row, status: "REMOVED" }), null);
});

test("errors: customer messages pass through, database errors don't", async () => {
  const friendly = await customDomainErrorResponse(Object.assign(new Error("Use your own domain."), { status: 400, code: "DOMAIN_RESERVED" })).json();
  assert.deepEqual(friendly, { error: "DOMAIN_RESERVED", message: "Use your own domain." });
  const db = await customDomainErrorResponse(Object.assign(new Error("relation does not exist"), { code: "42P01" })).json();
  assert.deepEqual(db, { error: "42P01" });
  const limited = customDomainErrorResponse(Object.assign(new Error("Rate limit reached for x"), { name: "RateLimitError", status: 429, code: "WORKSPACE_RATE_LIMIT_REACHED" }));
  assert.equal(limited.status, 429);
});

test("the engine task is started by id with only the row and action", async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ id: "run" }) }; };
  await triggerCustomDomainTask({ domainId: "dom-1", action: "check", env: { TRIGGER_SECRET_KEY: "tr_x" }, fetchImpl, now: 0 });
  assert.match(sent.url, /ssc-control-plane-manage-custom-domain\/trigger$/);
  assert.deepEqual(sent.body.payload, { domainId: "dom-1", action: "check" });
  await assert.rejects(triggerCustomDomainTask({ domainId: "d", action: "drop-table", env: { TRIGGER_SECRET_KEY: "x" }, fetchImpl }));
});
