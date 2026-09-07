import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { KMSClient } from "@aws-sdk/client-kms";
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
  persistManagedDatabaseReady,
  sscManagedDatabaseName,
} from "../src/managed-database-lifecycle.mjs";
import {
  DEFAULT_WORKSPACE_RESOURCE_POLICY,
  managedDatabaseLimitDecision,
} from "../src/workspace-resource-policy.mjs";
import {
  normalizeNeonProjectResource,
  operationIdsFromNeonResponse,
  restoreNeonBranch,
  waitForNeonOperations,
} from "../src/neon-managed-postgres.mjs";
import {
  assertProbeMutationChanged,
  initializeProbeData,
  mutateProbeData,
  normalizeConnectionIdentity,
  readProbeSummary,
  summarizeProbeRows,
} from "../src/managed-database-recovery-probe.mjs";

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

function probeDb() {
  let rows = [];
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (/CREATE TABLE IF NOT EXISTS ssc_recovery_probe/.test(sql)) return { rowCount: 0, rows: [] };
      if (/TRUNCATE ssc_recovery_probe/.test(sql)) {
        rows = [];
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO ssc_recovery_probe \(id, value\) VALUES \(1,'alpha'\),\(2,'bravo'\),\(3,'charlie'\)/.test(sql)) {
        rows = [
          { id: 1, value: "alpha" },
          { id: 2, value: "bravo" },
          { id: 3, value: "charlie" },
        ];
        return { rowCount: 3, rows: [] };
      }
      if (/DELETE FROM ssc_recovery_probe/.test(sql)) {
        rows = [];
        return { rowCount: 3, rows: [] };
      }
      if (/SELECT id, value\s+FROM ssc_recovery_probe\s+ORDER BY id ASC/.test(sql)) {
        return { rowCount: rows.length, rows: [...rows] };
      }
      throw new Error(`Unexpected probe SQL: ${sql}`);
    },
  };
}

function readyAttachmentDb({ deploymentStatus = "PROVISIONING", appDeletedAt = null, databaseStatus = ManagedDatabaseStatus.CREATE_REQUESTED } = {}) {
  const calls = [];
  const state = {
    appDeletedAt,
    appDatabaseStatus: databaseStatus,
    deploymentStatus,
    encryptedSecretWrites: 0,
    bindingWrites: 0,
    deploymentProviderId: null,
    events: [],
  };
  return {
    calls,
    state,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (/SELECT d\.status AS deployment_status,[\s\S]+FOR UPDATE OF d,a,ad/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            deployment_status: state.deploymentStatus,
            app_deleted_at: state.appDeletedAt,
            database_status: state.appDatabaseStatus,
            database_mode: DatabaseMode.SSC_MANAGED,
          }],
        };
      }
      if (/INSERT INTO encrypted_secrets/.test(sql)) {
        state.encryptedSecretWrites += 1;
        return { rowCount: 1, rows: [{ id: "secret-created-after-delete", name: params[2], kms_key_id: params[7] }] };
      }
      if (/INSERT INTO app_secret_bindings/.test(sql)) {
        state.bindingWrites += 1;
        return { rowCount: 1, rows: [{ id: "binding-created-after-delete" }] };
      }
      if (/UPDATE app_databases[\s\S]+status='READY'/.test(sql)) {
        state.appDatabaseStatus = ManagedDatabaseStatus.READY;
        return {
          rowCount: 1,
          rows: [{
            id: params[9],
            workspace_id: workspaceId,
            app_id: appId,
            database_mode: DatabaseMode.SSC_MANAGED,
            provider: "neon",
            provider_project_id: params[0],
            provider_project_name: params[1],
            connection_secret_id: params[7],
            status: state.appDatabaseStatus,
          }],
        };
      }
      if (/UPDATE deployments[\s\S]+SET database_provider_id=\$1/.test(sql)) {
        state.deploymentProviderId = params[0];
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO deployment_events/.test(sql)) {
        const eventType = sql.includes("'DATABASE_PROVIDER_RESULT_STALE'") ? "DATABASE_PROVIDER_RESULT_STALE"
          : sql.includes("'DATABASE_READY'") ? "DATABASE_READY"
            : params[2];
        const metadataParam = sql.includes("'DATABASE_PROVIDER_RESULT_STALE'") ? params[2]
          : sql.includes("'DATABASE_READY'") ? params[3]
            : params[4];
        state.events.push({ eventType, metadata: JSON.parse(metadataParam) });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in readyAttachmentDb: ${sql}`);
    },
  };
}

function mockKmsForTest(t) {
  const originalEnv = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_KMS_KEY_ID: process.env.AWS_KMS_KEY_ID,
  };
  const originalSend = KMSClient.prototype.send;
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_KMS_KEY_ID = "arn:aws:kms:us-east-1:111122223333:key/test";
  KMSClient.prototype.send = async () => ({
    Plaintext: Buffer.alloc(32, 7),
    CiphertextBlob: Buffer.from("encrypted-data-key"),
  });
  t.after(() => {
    KMSClient.prototype.send = originalSend;
    if (originalEnv.AWS_REGION === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originalEnv.AWS_REGION;
    if (originalEnv.AWS_KMS_KEY_ID === undefined) delete process.env.AWS_KMS_KEY_ID;
    else process.env.AWS_KMS_KEY_ID = originalEnv.AWS_KMS_KEY_ID;
  });
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

test("managed database provider result attaches only after current state fence passes", async (t) => {
  mockKmsForTest(t);
  const db = readyAttachmentDb();
  const row = {
    id: "db-row",
    workspace_id: workspaceId,
    app_id: appId,
    database_mode: DatabaseMode.SSC_MANAGED,
    provider: "neon",
    provider_project_name: sscManagedDatabaseName({ workspaceId, appId }),
    status: ManagedDatabaseStatus.CREATE_REQUESTED,
  };

  const ready = await persistManagedDatabaseReady(db, {
    deployment,
    row,
    resource: {
      providerProjectId: "neon-project",
      providerProjectName: row.provider_project_name,
      providerBranchId: "branch-id",
      providerEndpointId: "endpoint-id",
      providerDatabaseId: "database-id",
      providerDatabaseName: "neondb",
      providerRoleName: "neondb_owner",
    },
    connectionUri: "postgres://user:pass@example.neon.tech/neondb",
  });

  assert.equal(ready.status, ManagedDatabaseStatus.READY);
  assert.equal(db.state.encryptedSecretWrites, 1);
  assert.equal(db.state.bindingWrites, 1);
  assert.equal(db.state.deploymentProviderId, "neon-project");
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_READY"), true);
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_PROVIDER_RESULT_STALE"), false);
});

test("stale managed database provider result must not attach after app deletion", async (t) => {
  mockKmsForTest(t);
  const db = readyAttachmentDb({
    deploymentStatus: "DELETED",
    appDeletedAt: new Date().toISOString(),
    databaseStatus: ManagedDatabaseStatus.DELETED,
  });
  const staleDeployment = { ...deployment, status: "PROVISIONING" };
  const staleRow = {
    id: "db-row",
    workspace_id: workspaceId,
    app_id: appId,
    database_mode: DatabaseMode.SSC_MANAGED,
    provider: "neon",
    provider_project_name: sscManagedDatabaseName({ workspaceId, appId }),
    status: ManagedDatabaseStatus.CREATE_REQUESTED,
  };

  await persistManagedDatabaseReady(db, {
    deployment: staleDeployment,
    row: staleRow,
    resource: {
      providerProjectId: "neon-project-created-before-delete",
      providerProjectName: staleRow.provider_project_name,
      providerBranchId: "branch-id",
      providerEndpointId: "endpoint-id",
      providerDatabaseId: "database-id",
      providerDatabaseName: "neondb",
      providerRoleName: "neondb_owner",
    },
    connectionUri: "postgres://user:pass@example.neon.tech/neondb",
  });

  assert.equal(db.state.encryptedSecretWrites, 0, "stale provider result must not create a secret after deletion");
  assert.equal(db.state.bindingWrites, 0, "stale provider result must not create a runtime env binding after deletion");
  assert.equal(db.state.appDatabaseStatus, ManagedDatabaseStatus.DELETED, "deleted managed database row must not be marked READY");
  assert.equal(db.state.deploymentProviderId, null, "deleted deployment must not be updated with a provider database id");
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_READY"), false, "stale provider result must not record DATABASE_READY");
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_PROVIDER_RESULT_STALE"), true, "stale provider result should be auditable");
});

test("stale managed database provider result must not attach while deletion is in progress", async (t) => {
  mockKmsForTest(t);
  const db = readyAttachmentDb({
    deploymentStatus: "DELETING",
    databaseStatus: ManagedDatabaseStatus.DELETING,
  });
  const row = {
    id: "db-row",
    workspace_id: workspaceId,
    app_id: appId,
    database_mode: DatabaseMode.SSC_MANAGED,
    provider: "neon",
    provider_project_name: sscManagedDatabaseName({ workspaceId, appId }),
    status: ManagedDatabaseStatus.CREATE_REQUESTED,
  };

  const result = await persistManagedDatabaseReady(db, {
    deployment,
    row,
    resource: {
      providerProjectId: "neon-project-created-before-delete",
      providerProjectName: row.provider_project_name,
      providerBranchId: "branch-id",
      providerEndpointId: "endpoint-id",
      providerDatabaseId: "database-id",
      providerDatabaseName: "neondb",
      providerRoleName: "neondb_owner",
    },
    connectionUri: "postgres://user:pass@example.neon.tech/neondb",
  });

  assert.equal(result.result, "DATABASE_PROVIDER_RESULT_STALE");
  assert.equal(result.staleReason, "DEPLOYMENT_DELETING_OR_DELETED");
  assert.equal(db.state.encryptedSecretWrites, 0);
  assert.equal(db.state.bindingWrites, 0);
  assert.equal(db.state.appDatabaseStatus, ManagedDatabaseStatus.DELETING);
  assert.equal(db.state.deploymentProviderId, null);
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_READY"), false);
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_PROVIDER_RESULT_STALE"), true);
});

test("stale managed database provider result must not attach after deployment is deleted", async (t) => {
  mockKmsForTest(t);
  const db = readyAttachmentDb({
    deploymentStatus: "DELETED",
    databaseStatus: ManagedDatabaseStatus.CREATE_REQUESTED,
  });
  const row = {
    id: "db-row",
    workspace_id: workspaceId,
    app_id: appId,
    database_mode: DatabaseMode.SSC_MANAGED,
    provider: "neon",
    provider_project_name: sscManagedDatabaseName({ workspaceId, appId }),
    status: ManagedDatabaseStatus.CREATE_REQUESTED,
  };

  const result = await persistManagedDatabaseReady(db, {
    deployment,
    row,
    resource: {
      providerProjectId: "neon-project-created-before-delete",
      providerProjectName: row.provider_project_name,
      providerBranchId: "branch-id",
      providerEndpointId: "endpoint-id",
      providerDatabaseId: "database-id",
      providerDatabaseName: "neondb",
      providerRoleName: "neondb_owner",
    },
    connectionUri: "postgres://user:pass@example.neon.tech/neondb",
  });

  assert.equal(result.result, "DATABASE_PROVIDER_RESULT_STALE");
  assert.equal(result.staleReason, "DEPLOYMENT_DELETING_OR_DELETED");
  assert.equal(db.state.encryptedSecretWrites, 0);
  assert.equal(db.state.bindingWrites, 0);
  assert.equal(db.state.appDatabaseStatus, ManagedDatabaseStatus.CREATE_REQUESTED);
  assert.equal(db.state.deploymentProviderId, null);
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_READY"), false);
  assert.equal(db.state.events.some((event) => event.eventType === "DATABASE_PROVIDER_RESULT_STALE"), true);
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

test("Neon branch restore helper uses provider-native LSN restore without credentials in request", async () => {
  const calls = [];
  await restoreNeonBranch({
    projectId: "project-id",
    branchId: "branch-id",
    sourceBranchId: "branch-id",
    sourceLsn: "0/1A2B3C4",
    preserveUnderName: "backup-before-restore",
  }, {
    request: async (path, options) => {
      calls.push({ path, options });
      return { operations: [{ id: "operation-id" }] };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/projects/project-id/branches/branch-id/restore");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    source_branch_id: "branch-id",
    source_lsn: "0/1A2B3C4",
    preserve_under_name: "backup-before-restore",
  });
  assert.equal(JSON.stringify(body).includes("postgres://"), false);
  assert.equal(JSON.stringify(body).includes("password"), false);
});

test("Neon operation polling waits for completion and fails closed on provider failure", async () => {
  const completed = await waitForNeonOperations({
    projectId: "project-id",
    operationIds: operationIdsFromNeonResponse({ operations: [{ id: "op-1" }] }),
    pollMs: 0,
  }, {
    getOperation: async () => ({ operation: { status: "finished" } }),
    sleep: async () => {},
  });
  assert.deepEqual(completed, [{ operationId: "op-1", status: "finished" }]);

  await assert.rejects(
    () => waitForNeonOperations({ projectId: "project-id", operationIds: ["op-2"], pollMs: 0 }, {
      getOperation: async () => ({ operation: { status: "failed" } }),
      sleep: async () => {},
    }),
    /failed with status failed/,
  );
});

test("recovery probe initial data has deterministic row count and digest", async () => {
  const db = probeDb();
  const original = await initializeProbeData(db);
  const repeated = await readProbeSummary(db);

  assert.equal(original.rowCount, 3);
  assert.equal(repeated.rowCount, 3);
  assert.equal(repeated.digest, original.digest);
  assert.deepEqual(original, summarizeProbeRows([
    { id: 1, value: "alpha" },
    { id: 2, value: "bravo" },
    { id: 3, value: "charlie" },
  ]));
});

test("recovery probe destructive mutation changes row count and digest from a fresh query", async () => {
  const db = probeDb();
  const original = await initializeProbeData(db);
  const mutated = await mutateProbeData(db);

  assert.equal(mutated.rowCount, 0);
  assert.notEqual(mutated.digest, original.digest);
  assert.ok(db.calls.find((sql) => /DELETE FROM ssc_recovery_probe/.test(sql)));
  assert.equal(db.calls.filter((sql) => /SELECT id, value\s+FROM ssc_recovery_probe\s+ORDER BY id ASC/.test(sql)).length, 2);
});

test("post-mutation verification cannot reuse original cached rows", async () => {
  const original = summarizeProbeRows([{ id: 1, value: "alpha" }]);
  const cached = summarizeProbeRows([{ id: 1, value: "alpha" }]);

  assert.throws(
    () => assertProbeMutationChanged({
      original,
      mutated: cached,
      mutationDbIdentity: { host: "same", database: "db" },
      verificationDbIdentity: { host: "same", database: "db" },
    }),
    /Destructive test mutation did not change probe data/,
  );
});

test("mutation and verification database identity mismatch fails before restore", () => {
  const original = summarizeProbeRows([{ id: 1, value: "alpha" }]);
  const mutated = summarizeProbeRows([]);

  assert.throws(
    () => assertProbeMutationChanged({
      original,
      mutated,
      mutationDbIdentity: normalizeConnectionIdentity("postgres://user:pass@one.neon.tech/db?sslmode=require"),
      verificationDbIdentity: normalizeConnectionIdentity("postgres://user:pass@two.neon.tech/db?sslmode=require"),
    }),
    /different database identities/,
  );
});

test("drill captures LSN before destructive mutation", () => {
  const script = readControlPlaneFile("scripts/run-managed-database-recovery-drill.mjs");
  const runSequence = script.slice(script.indexOf("const original = await initializeProbeData"));
  assert.ok(runSequence.indexOf("initializeProbeData") < runSequence.indexOf("pg_current_wal_lsn"));
  assert.ok(runSequence.indexOf("pg_current_wal_lsn") < runSequence.indexOf("mutateProbeData"));
  assert.ok(runSequence.indexOf("mutateProbeData") < runSequence.indexOf("restoreNeonBranch"));
});

test("managed database recovery drill runner is guarded and never prints database URLs", () => {
  const script = readControlPlaneFile("scripts/run-managed-database-recovery-drill.mjs");
  assert.match(script, /SSC_MANAGED_DB_RECOVERY_DRILL_CONFIRM/);
  assert.match(script, /CREATE_DISPOSABLE_NEON_RECOVERY_DRILL/);
  assert.match(script, /SSC_MANAGED_DB_RECOVERY_DRILL_CLEANUP_CONFIRM/);
  assert.match(script, /DELETE_DISPOSABLE_NEON_RECOVERY_DRILL_RESOURCE/);
  assert.match(script, /plaintextDatabaseCredentialsPrinted: false/);
  assert.match(script, /sourceLsn: recoveryLsn/);
  assert.match(script, /preserveUnderName/);
  assert.match(script, /cleanupRequired: Boolean\(resource\?\.providerProjectId\)/);
  assert.doesNotMatch(script, /connectionUri:/);
  assert.doesNotMatch(script, /safeConnectionUri:/);
  assert.doesNotMatch(script, /DATABASE_URL/);
});

test("production orchestration provisions managed database before runtime env and build", () => {
  const orchestrator = readControlPlaneFile("trigger/orchestrate-deployment.ts");
  assert.ok(orchestrator.indexOf("ssc-control-plane-provision-database") < orchestrator.indexOf("ssc-control-plane-provision-runtime"));
  assert.ok(orchestrator.indexOf("ssc-control-plane-provision-database") < orchestrator.indexOf("ssc-control-plane-apply-runtime-env"));
});

test("managed database READY replay returns before provider enumeration", () => {
  const provisionDatabase = readControlPlaneFile("trigger/provision-database.ts");
  const readyReplay = provisionDatabase.indexOf("row.status === ManagedDatabaseStatus.READY && row.connection_secret_id");
  const providerEnumeration = provisionDatabase.indexOf("const candidates = await listNeonProjectsByName");
  assert.ok(readyReplay > 0);
  assert.ok(readyReplay < providerEnumeration);
  assert.match(provisionDatabase.slice(readyReplay, providerEnumeration), /NODE_15R_12A_MANAGED_DATABASE_READY/);
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
