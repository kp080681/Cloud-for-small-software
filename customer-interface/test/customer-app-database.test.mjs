import test from "node:test";
import assert from "node:assert/strict";
import { directConnectionString, getAppDatabaseSummary, revealAppDatabaseConnection } from "../src/server/customer-app-database.mjs";

const POOLED = "postgresql://app_user:secret@ep-cool-river-123456-pooler.us-east-2.aws.neon.tech/appdb?sslmode=require";

class FakeDb {
  constructor(row) {
    this.row = row;
    this.params = null;
  }
  async query(text, params) {
    assert.match(text, /customer_workspace_memberships/);
    assert.match(text, /SSC_MANAGED/);
    this.params = params;
    const [customerId, workspaceId, appId] = params;
    const ok = this.row && customerId === "cust-1" && workspaceId === "ws-1" && appId === "app-1";
    return { rows: ok ? [this.row] : [] };
  }
}

const ids = { customerId: "cust-1", workspaceId: "ws-1", appId: "app-1" };

test("direct address drops the pooler suffix and nothing else", () => {
  assert.equal(
    directConnectionString(POOLED),
    "postgresql://app_user:secret@ep-cool-river-123456.us-east-2.aws.neon.tech/appdb?sslmode=require",
  );
  const direct = "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db";
  assert.equal(directConnectionString(direct), direct);
});

test("a ready managed database reveals its direct connection string", async () => {
  let asked;
  const decrypt = async (_db, args) => {
    asked = args;
    return POOLED;
  };
  const result = await revealAppDatabaseConnection(new FakeDb({ status: "READY" }), { ...ids, decrypt });
  assert.deepEqual(asked, { appId: "app-1", name: "DATABASE_URL" });
  assert.equal(result.connectionString.includes("-pooler"), false);
});

test("no database, or someone outside the workspace, gets not found", async () => {
  const decrypt = async () => {
    throw new Error("must not decrypt");
  };
  await assert.rejects(revealAppDatabaseConnection(new FakeDb(null), { ...ids, decrypt }), (e) => e.code === "APP_DATABASE_NOT_FOUND");
  await assert.rejects(
    revealAppDatabaseConnection(new FakeDb({ status: "READY" }), { ...ids, customerId: "stranger", decrypt }),
    (e) => e.code === "APP_DATABASE_NOT_FOUND" && e.status === 404,
  );
});

test("a database still being created is not revealed", async () => {
  const decrypt = async () => {
    throw new Error("must not decrypt");
  };
  await assert.rejects(
    revealAppDatabaseConnection(new FakeDb({ status: "CREATE_REQUESTED" }), { ...ids, decrypt }),
    (e) => e.code === "APP_DATABASE_NOT_READY",
  );
});

test("a decrypt failure or a malformed secret becomes a safe error", async () => {
  await assert.rejects(
    revealAppDatabaseConnection(new FakeDb({ status: "READY" }), { ...ids, decrypt: async () => { throw new Error("kms denied"); } }),
    (e) => e.code === "APP_DATABASE_SECRET_UNAVAILABLE" && !String(e.message).includes("kms"),
  );
  await assert.rejects(
    revealAppDatabaseConnection(new FakeDb({ status: "READY" }), { ...ids, decrypt: async () => "not-a-url" }),
    (e) => e.code === "APP_DATABASE_SECRET_UNAVAILABLE",
  );
});

test("summary reports readiness", async () => {
  assert.deepEqual(
    (await getAppDatabaseSummary(new FakeDb({ status: "READY", created_at: "2026-10-01T00:00:00Z" }), ids)),
    { status: "READY", ready: true, createdAt: "2026-10-01T00:00:00.000Z" },
  );
  assert.equal(await getAppDatabaseSummary(new FakeDb(null), ids), null);
});
