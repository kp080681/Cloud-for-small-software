import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DatabaseMode,
  ManagedDatabaseStatus,
  claimManagedDatabaseCreate,
  classifyManagedDatabaseResource,
  deleteManagedDatabaseForApp,
  ensureManagedDatabaseIntent,
  ensureTlsConnectionString,
  isSscManagedDatabaseName,
  managedDatabaseReconciliationKey,
  normalizeDatabaseMode,
  sscManagedDatabaseName,
} from "../src/managed-database-lifecycle.mjs";
import {
  DEFAULT_WORKSPACE_RESOURCE_POLICY,
  managedDatabaseLimitDecision,
} from "../src/workspace-resource-policy.mjs";
import { normalizeNeonProjectResource } from "../src/neon-managed-postgres.mjs";

const root = path.resolve(import.meta.dirname, "..");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const deployment = {
  id: "33333333-3333-4333-8333-333333333333",
  workspace_id: workspaceId,
  app_id: appId,
  status: "PROVISIONING",
  database_required: true,
  database_mode: DatabaseMode.SSC_MANAGED,
};

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function intentDb({ existing = null, activeManagedDatabases = 0, maxManagedDatabases = 3 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (/FROM app_databases\s+WHERE app_id=\$1\s+FOR UPDATE/.test(sql)) {
        return existing ? { rowCount: 1, rows: [existing] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT id FROM workspaces/.test(sql)) return { rowCount: 1, rows: [{ id: params[0] }] };
      if (/INSERT INTO workspace_resource_policies/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM workspace_resource_policies/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            workspace_id: params[0],
            max_active_apps: 3,
            max_active_deployments: 3,
            max_active_deployments_per_app: 1,
            max_concurrent_provider_operations: 2,
            max_managed_databases: maxManagedDatabases,
          }],
        };
      }
      if (/count\(\*\)::int AS count\s+FROM app_databases/.test(sql)) return { rowCount: 1, rows: [{ count: activeManagedDatabases }] };
      if (/INSERT INTO app_databases/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: "db-row",
            workspace_id: workspaceId,
            app_id: appId,
            database_mode: DatabaseMode.SSC_MANAGED,
            provider: "neon",
            provider_project_name: params[2],
            reconciliation_key: params[3],
            status: ManagedDatabaseStatus.INTENT_RECORDED,
          }],
        };
      }
      if (/INSERT INTO deployment_events/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL in intentDb: ${sql}`);
    },
  };
}

function deleteDb(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT \*\s+FROM app_databases\s+WHERE app_id=\$1\s+FOR UPDATE/.test(sql)) {
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      if (/UPDATE app_databases/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL in deleteDb: ${sql}`);
    },
  };
}

test("database modes are explicit and database-required legacy apps normalize to external", () => {
  assert.equal(normalizeDatabaseMode("NONE"), DatabaseMode.NONE);
  assert.equal(normalizeDatabaseMode("EXTERNAL"), DatabaseMode.EXTERNAL);
  assert.equal(normalizeDatabaseMode("SSC_MANAGED"), DatabaseMode.SSC_MANAGED);
  assert.equal(normalizeDatabaseMode(null, { databaseRequired: true }), DatabaseMode.EXTERNAL);
  assert.equal(normalizeDatabaseMode(null, { databaseRequired: false }), DatabaseMode.NONE);
});

test("managed database naming uses workspace/app identity and not slug alone", () => {
  const name = sscManagedDatabaseName({ workspaceId, appId });
  assert.equal(isSscManagedDatabaseName(name), true);
  assert.equal(name.includes("dealup"), false);
  assert.equal(managedDatabaseReconciliationKey({ workspaceId, appId }), `database:neon:${workspaceId}:${appId}`);
});

test("workspace managed database limit is conservative and enforced before intent insert", async () => {
  assert.equal(DEFAULT_WORKSPACE_RESOURCE_POLICY.maxManagedDatabases, 3);
  assert.equal(managedDatabaseLimitDecision({ managedDatabaseCount: 3, policy: DEFAULT_WORKSPACE_RESOURCE_POLICY }).code, "WORKSPACE_MANAGED_DATABASE_LIMIT_REACHED");
  const db = intentDb({ activeManagedDatabases: 3, maxManagedDatabases: 3 });
  const result = await ensureManagedDatabaseIntent(db, deployment);
  assert.equal(result.action, "blocked");
  assert.equal(result.decision.code, "WORKSPACE_MANAGED_DATABASE_LIMIT_REACHED");
  assert.equal(db.calls.some((call) => /INSERT INTO app_databases/.test(call.sql)), false);
});

test("existing managed database reconciliation bypasses quota when workspace is full", async () => {
  const existing = { id: "db-row", workspace_id: workspaceId, app_id: appId, database_mode: DatabaseMode.SSC_MANAGED, provider: "neon", status: ManagedDatabaseStatus.CREATE_REQUESTED };
  const db = intentDb({ existing, activeManagedDatabases: 99, maxManagedDatabases: 0 });
  const result = await ensureManagedDatabaseIntent(db, deployment);
  assert.equal(result.action, "existing");
  assert.equal(db.calls.some((call) => /count\(\*\)::int AS count\s+FROM app_databases/.test(call.sql)), false);
});

test("create claim permits exactly one provider creator", async () => {
  const claimed = await claimManagedDatabaseCreate({
    async query(sql, params) {
      assert.match(sql, /UPDATE app_databases/);
      return { rowCount: 1, rows: [{ id: params[0], status: ManagedDatabaseStatus.CREATE_REQUESTED }] };
    },
  }, { id: "db-row" });
  assert.equal(claimed.status, ManagedDatabaseStatus.CREATE_REQUESTED);
  assert.equal(await claimManagedDatabaseCreate({ query: async () => ({ rowCount: 0, rows: [] }) }, { id: "db-row" }), null);
});

test("NONE and EXTERNAL app deletion never call Neon, even for Neon-looking external URLs", async () => {
  let neonCalls = 0;
  const getProject = async () => { neonCalls += 1; throw new Error("must not call Neon"); };
  const deleteProject = async () => { neonCalls += 1; throw new Error("must not call Neon"); };
  assert.equal((await deleteManagedDatabaseForApp(deleteDb(null), { workspaceId, appId, getProject, deleteProject })).databaseMode, DatabaseMode.NONE);
  const external = { workspace_id: workspaceId, app_id: appId, database_mode: DatabaseMode.EXTERNAL, provider: "neon", provider_project_id: "external-neon-looking", status: "READY" };
  assert.equal((await deleteManagedDatabaseForApp(deleteDb(external), { workspaceId, appId, getProject, deleteProject })).databaseMode, DatabaseMode.EXTERNAL);
  assert.equal(neonCalls, 0);
});

test("UNKNOWN ownership fails closed for destructive database action", async () => {
  await assert.rejects(
    () => deleteManagedDatabaseForApp(deleteDb({ workspace_id: workspaceId, app_id: appId, database_mode: null, provider: "neon", provider_project_id: "project", provider_project_name: "project-name", status: "READY" }), {
      workspaceId,
      appId,
      getProject: async () => null,
      deleteProject: async () => ({}),
    }),
    /Unknown database ownership mode/,
  );
});

test("managed database deletion verifies tenant and provider identity before delete", async () => {
  const providerProjectName = sscManagedDatabaseName({ workspaceId, appId });
  const row = { id: "db-row", workspace_id: workspaceId, app_id: appId, database_mode: DatabaseMode.SSC_MANAGED, provider: "neon", provider_project_id: "neon-project", provider_project_name: providerProjectName, status: "READY" };
  const deletedIds = [];
  const db = deleteDb(row);
  const result = await deleteManagedDatabaseForApp(db, {
    workspaceId,
    appId,
    getProject: async () => ({ id: "neon-project", name: providerProjectName }),
    deleteProject: async (id) => {
      deletedIds.push(id);
      return { deleted: true, notFound: false };
    },
  });
  assert.equal(result.action, "deleted");
  assert.deepEqual(deletedIds, ["neon-project"]);
  assert.ok(db.calls.some((call) => /status='DELETING'/.test(call.sql)));
  assert.ok(db.calls.some((call) => /status='DELETED'/.test(call.sql)));
  await assert.rejects(
    () => deleteManagedDatabaseForApp(deleteDb({ ...row, workspace_id: "workspace-b" }), { workspaceId, appId, getProject: async () => null, deleteProject: async () => ({}) }),
    /workspace\/app ownership mismatch/,
  );
});

test("provider identity mismatch refuses destructive managed database delete", async () => {
  const row = { id: "db-row", workspace_id: workspaceId, app_id: appId, database_mode: DatabaseMode.SSC_MANAGED, provider: "neon", provider_project_id: "neon-project", provider_project_name: sscManagedDatabaseName({ workspaceId, appId }), status: "READY" };
  await assert.rejects(
    () => deleteManagedDatabaseForApp(deleteDb(row), {
      workspaceId,
      appId,
      getProject: async () => ({ id: "neon-project", name: "wrong-name" }),
      deleteProject: async () => { throw new Error("must not delete"); },
    }),
    /provider identity mismatch/,
  );
});

test("managed database resource classification covers known recoverable orphan ambiguous and foreign", () => {
  const providerProjectName = sscManagedDatabaseName({ workspaceId, appId });
  const row = { appId, databaseMode: DatabaseMode.SSC_MANAGED, providerProjectId: "neon-project", providerProjectName, status: "READY" };
  const controlPlane = {
    databasesByProviderProjectId: new Map([["neon-project", row]]),
    databasesByProviderProjectName: new Map([[providerProjectName, row]]),
  };
  assert.equal(classifyManagedDatabaseResource({ id: "neon-project", name: providerProjectName }, controlPlane).classification, "KNOWN");
  assert.equal(classifyManagedDatabaseResource({ id: "other-id", name: providerProjectName }, controlPlane).classification, "RECOVERABLE");
  assert.equal(classifyManagedDatabaseResource({ id: "missing", name: sscManagedDatabaseName({ workspaceId, appId: "44444444-4444-4444-8444-444444444444" }) }, {
    databasesByProviderProjectId: new Map(),
    databasesByProviderProjectName: new Map(),
  }).classification, "ORPHAN");
  assert.equal(classifyManagedDatabaseResource({ id: "missing", name: "customer-db" }, controlPlane).classification, "FOREIGN_IGNORE");
  assert.equal(classifyManagedDatabaseResource({ id: "neon-project", name: providerProjectName }, controlPlane, { ambiguousNames: new Set([providerProjectName]) }).classification, "AMBIGUOUS");
});

test("Neon resource normalization and TLS connection string are safe for production binding", () => {
  assert.deepEqual(normalizeNeonProjectResource({
    project: { id: "project-id", name: "project-name", default_branch_id: "branch-id" },
    endpoints: [{ id: "endpoint-id" }],
    databases: [{ id: 123, name: "appdb" }],
    roles: [{ name: "app_owner" }],
  }), {
    providerProjectId: "project-id",
    providerProjectName: "project-name",
    providerBranchId: "branch-id",
    providerEndpointId: "endpoint-id",
    providerDatabaseId: 123,
    providerDatabaseName: "appdb",
    providerRoleName: "app_owner",
  });
  assert.equal(ensureTlsConnectionString("postgres://user:pass@example.neon.tech/appdb").includes("sslmode=require"), true);
  assert.equal(ensureTlsConnectionString("postgres://user:pass@example.neon.tech/appdb?sslmode=require"), "postgres://user:pass@example.neon.tech/appdb?sslmode=require");
});

test("production orchestration provisions managed database before runtime env and build", () => {
  const orchestrator = readControlPlaneFile("trigger/orchestrate-deployment.ts");
  assert.ok(orchestrator.indexOf("ssc-control-plane-provision-database") < orchestrator.indexOf("ssc-control-plane-provision-runtime"));
  assert.ok(orchestrator.indexOf("ssc-control-plane-provision-database") < orchestrator.indexOf("ssc-control-plane-apply-runtime-env"));
});

test("app deletion clears managed database secret reference before deleting encrypted secrets", () => {
  const deleteApp = readControlPlaneFile("trigger/delete-app.ts");
  assert.ok(
    deleteApp.indexOf("UPDATE app_databases SET connection_secret_id=NULL") < deleteApp.indexOf("DELETE FROM encrypted_secrets"),
    "database secret reference must be cleared before app-scoped encrypted secrets are deleted",
  );
});

test("provisioning path encrypts DATABASE_URL before durable binding and does not print plaintext", () => {
  const lifecycle = readControlPlaneFile("src/managed-database-lifecycle.mjs");
  const provisionDatabase = readControlPlaneFile("trigger/provision-database.ts");
  assert.match(lifecycle, /encryptAppSecret/);
  assert.match(lifecycle, /name: "DATABASE_URL"/);
  assert.match(lifecycle, /app_secret_bindings/);
  assert.match(lifecycle, /'production'/);
  assert.doesNotMatch(provisionDatabase, /console\.log/);
  assert.doesNotMatch(provisionDatabase, /connectionUri[^\n]*metadata/);
});

test("provider response loss searches deterministic SSC identity before create", () => {
  const provisionDatabase = readControlPlaneFile("trigger/provision-database.ts");
  const lifecycle = readControlPlaneFile("src/managed-database-lifecycle.mjs");
  const runBody = provisionDatabase.slice(provisionDatabase.indexOf("const candidates = await listNeonProjectsByName"));
  assert.ok(runBody.indexOf("listNeonProjectsByName") < runBody.indexOf("createNeonProject"));
  assert.match(lifecycle, /status IN \('INTENT_RECORDED'\)/);
  assert.doesNotMatch(lifecycle, /RECONCILIATION_REQUIRED','FAILED/);
  assert.match(provisionDatabase, /NODE_15R_12A_DATABASE_RECONCILIATION_AMBIGUOUS/);
  assert.match(provisionDatabase, /NODE_15R_12A_DATABASE_RECONCILIATION_REQUIRED/);
});

test("migration records explicit ownership and managed database quota without applying it", () => {
  const migration = readControlPlaneFile("db/016_managed_customer_databases.sql");
  assert.match(migration, /ADD COLUMN database_mode text NOT NULL DEFAULT 'NONE'/);
  assert.match(migration, /WHEN database_required THEN 'EXTERNAL'/);
  assert.match(migration, /UPDATE app_databases\s+SET database_mode = 'EXTERNAL'/);
  assert.match(migration, /app_databases_reconciliation_key_idx/);
  assert.match(migration, /max_managed_databases integer NOT NULL DEFAULT 3/);
});
