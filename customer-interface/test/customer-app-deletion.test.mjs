import test from "node:test";
import assert from "node:assert/strict";
import { requestCustomerAppDeletion } from "../src/server/customer-app-deletion.mjs";
import { triggerAppDeletionTask } from "../src/server/customer-deployments.mjs";

class FakeDb {
  constructor({ app = { id: "app-1", name: "my-shop", deleted_at: null }, running = false, deletion = null } = {}) {
    Object.assign(this, { app, running, deletion });
  }
  async query(text, params = []) {
    if (text.includes("FROM customer_workspace_memberships m")) {
      const [customerId, workspaceId, appId] = params;
      const ok = this.app && customerId === "cust-1" && workspaceId === "ws-1" && appId === this.app.id;
      return { rows: ok ? [this.app] : [] };
    }
    if (text.includes("FROM deployments")) return { rowCount: this.running ? 1 : 0, rows: [] };
    if (text.includes("FROM app_deletions")) return { rows: this.deletion ? [this.deletion] : [] };
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

function recorder() {
  const calls = [];
  const trigger = async (args) => {
    calls.push(args);
    return { id: "run_1" };
  };
  return { calls, trigger };
}

const base = { customerId: "cust-1", workspaceId: "ws-1", appId: "app-1", keyFactory: () => "del_new" };

test("starts deletion when the typed name matches", async () => {
  const { calls, trigger } = recorder();
  const result = await requestCustomerAppDeletion(new FakeDb(), { ...base, confirmName: "  my-shop ", trigger });
  assert.deepEqual(result, { status: "DELETING", alreadyRequested: false });
  assert.deepEqual(calls, [{ appId: "app-1", workspaceId: "ws-1", deletionKey: "del_new" }]);
});

test("refuses when the typed name does not match", async () => {
  const { calls, trigger } = recorder();
  await assert.rejects(
    requestCustomerAppDeletion(new FakeDb(), { ...base, confirmName: "My-Shop", trigger }),
    (error) => error.code === "DELETE_CONFIRMATION_MISMATCH" && error.status === 400,
  );
  await assert.rejects(
    requestCustomerAppDeletion(new FakeDb(), { ...base, confirmName: undefined, trigger }),
    (error) => error.code === "DELETE_CONFIRMATION_MISMATCH",
  );
  assert.equal(calls.length, 0);
});

test("someone outside the workspace gets not found, and nothing is triggered", async () => {
  const { calls, trigger } = recorder();
  await assert.rejects(
    requestCustomerAppDeletion(new FakeDb(), { ...base, customerId: "stranger", confirmName: "my-shop", trigger }),
    (error) => error.code === "APP_NOT_FOUND" && error.status === 404,
  );
  assert.equal(calls.length, 0);
});

test("waits for a running deployment to finish", async () => {
  const { calls, trigger } = recorder();
  await assert.rejects(
    requestCustomerAppDeletion(new FakeDb({ running: true }), { ...base, confirmName: "my-shop", trigger }),
    (error) => error.code === "DEPLOYMENT_IN_PROGRESS" && error.status === 409,
  );
  assert.equal(calls.length, 0);
});

test("an already deleted app reports deleted without triggering", async () => {
  const { calls, trigger } = recorder();
  const db = new FakeDb({ app: { id: "app-1", name: "my-shop", deleted_at: new Date() } });
  assert.deepEqual(await requestCustomerAppDeletion(db, { ...base, confirmName: "whatever", trigger }), { status: "DELETED" });
  assert.equal(calls.length, 0);
});

test("a recent in-flight deletion is not started twice", async () => {
  const { calls, trigger } = recorder();
  const db = new FakeDb({ deletion: { deletion_key: "del_old", status: "DELETING", recent: true } });
  const result = await requestCustomerAppDeletion(db, { ...base, confirmName: "my-shop", trigger });
  assert.deepEqual(result, { status: "DELETING", alreadyRequested: true });
  assert.equal(calls.length, 0);
});

test("a failed or stalled deletion is retried with its original key", async () => {
  for (const deletion of [
    { deletion_key: "del_old", status: "FAILED", recent: true },
    { deletion_key: "del_old", status: "DELETING", recent: false },
  ]) {
    const { calls, trigger } = recorder();
    await requestCustomerAppDeletion(new FakeDb({ deletion }), { ...base, confirmName: "my-shop", trigger });
    assert.equal(calls[0].deletionKey, "del_old");
  }
});

test("the trigger call targets the engine's delete task with a per-minute idempotency key", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ id: "run_1" }) };
  };
  await triggerAppDeletionTask({
    appId: "app-1",
    workspaceId: "ws-1",
    deletionKey: "del_x",
    env: { TRIGGER_SECRET_KEY: "tr_test" },
    fetchImpl,
    now: 120_000,
  });
  assert.equal(seen.url, "https://api.trigger.dev/api/v1/tasks/ssc-control-plane-delete-app/trigger");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.payload, { appId: "app-1", workspaceId: "ws-1", deletionKey: "del_x" });
  assert.equal(body.options.idempotencyKey, "del_x:2");
  assert.equal(seen.init.headers.Authorization, "Bearer tr_test");
});

test("a refused trigger surfaces as a start failure", async () => {
  await assert.rejects(
    triggerAppDeletionTask({
      appId: "a",
      workspaceId: "w",
      deletionKey: "k",
      env: { TRIGGER_SECRET_KEY: "x" },
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    }),
    (error) => error.code === "APP_DELETION_START_FAILED",
  );
});
