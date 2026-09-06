import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ACTIVE_DEPLOYMENT_STATES,
  DEFAULT_WORKSPACE_RESOURCE_POLICY,
  WorkspaceResourcePolicyError,
  activeAppLimitDecision,
  activeDeploymentLimitDecision,
  ensureBuildOperationWithinWorkspaceLimit,
  providerOperationLimitDecision,
  validateWorkspaceResourcePolicy,
} from "../src/workspace-resource-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function buildOperationDb({ existingOperation = null, activeOperations = 0, workspaceExists = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (/FROM deployment_provider_operations\s+WHERE deployment_id=\$1/.test(sql)) {
        return existingOperation ? { rowCount: 1, rows: [existingOperation] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT id FROM workspaces/.test(sql)) {
        return workspaceExists ? { rowCount: 1, rows: [{ id: params[0] }] } : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO workspace_resource_policies/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM workspace_resource_policies/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            workspace_id: params[0],
            max_active_apps: 3,
            max_active_deployments: 3,
            max_active_deployments_per_app: 1,
            max_concurrent_provider_operations: 1,
            max_managed_databases: 3,
          }],
        };
      }
      if (/count\(\*\)::int AS count\s+FROM deployment_provider_operations/.test(sql)) {
        return { rowCount: 1, rows: [{ count: activeOperations }] };
      }
      if (/UPDATE deployments/.test(sql) || /INSERT INTO deployment_events/.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO deployment_provider_operations/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: "op-created",
            deployment_id: params[0],
            status: "INTENT_RECORDED",
            provider_resource_id: null,
            source_commit_sha: params[2],
          }],
        };
      }
      throw new Error(`Unexpected SQL in workspace resource policy test: ${sql}`);
    },
  };
}

const policy = DEFAULT_WORKSPACE_RESOURCE_POLICY;

test("controlled-alpha workspace defaults are conservative and explicit", () => {
  assert.deepEqual(policy, {
    maxActiveApps: 3,
    maxActiveDeployments: 3,
    maxActiveDeploymentsPerApp: 1,
    maxConcurrentProviderOperations: 2,
    maxManagedDatabases: 3,
  });
  assert.deepEqual(ACTIVE_DEPLOYMENT_STATES, [
    "DRAFT",
    "READY",
    "QUEUED",
    "ANALYZING",
    "PROVISIONING",
    "BUILDING",
    "DEPLOYING",
    "HEALTH_CHECKING",
    "DELETING",
  ]);
});

test("workspace at active-app limit is refused and deleted apps are excluded by production count", () => {
  assert.deepEqual(activeAppLimitDecision({ activeAppCount: 3, policy }), {
    allowed: false,
    code: "WORKSPACE_APP_LIMIT_REACHED",
    observed: 3,
    limit: 3,
    message: "Workspace active app limit reached: 3/3.",
  });
  assert.deepEqual(activeAppLimitDecision({ activeAppCount: 2, policy }), { allowed: true });

  const createAppDeployment = readControlPlaneFile("scripts/create-app-deployment.mjs");
  const workspacePolicy = readControlPlaneFile("src/workspace-resource-policy.mjs");
  assert.match(createAppDeployment, /enforceActiveAppLimit/);
  assert.match(createAppDeployment, /deleted_at/);
  assert.match(createAppDeployment, /requires explicit recovery before reuse/);
  assert.match(workspacePolicy, /deleted_at IS NULL/);
});

test("app and workspace active deployment limits refuse new deployment admission", () => {
  assert.deepEqual(activeDeploymentLimitDecision({
    appActiveDeploymentCount: 1,
    workspaceActiveDeploymentCount: 1,
    policy,
  }).code, "APP_DEPLOYMENT_LIMIT_REACHED");

  assert.deepEqual(activeDeploymentLimitDecision({
    appActiveDeploymentCount: 0,
    workspaceActiveDeploymentCount: 3,
    policy,
  }).code, "WORKSPACE_DEPLOYMENT_LIMIT_REACHED");

  assert.deepEqual(activeDeploymentLimitDecision({
    appActiveDeploymentCount: 0,
    workspaceActiveDeploymentCount: 2,
    policy,
  }), { allowed: true });
});

test("terminal historical deployments are not active deployment states", () => {
  assert.equal(ACTIVE_DEPLOYMENT_STATES.includes("LIVE"), false);
  assert.equal(ACTIVE_DEPLOYMENT_STATES.includes("FAILED"), false);
  assert.equal(ACTIVE_DEPLOYMENT_STATES.includes("DELETED"), false);
});

test("workspace provider operation limit is workspace scoped", () => {
  assert.deepEqual(providerOperationLimitDecision({
    activeProviderOperationCount: 2,
    policy,
  }).code, "WORKSPACE_PROVIDER_OPERATION_LIMIT_REACHED");
  assert.deepEqual(providerOperationLimitDecision({
    activeProviderOperationCount: 1,
    policy,
  }), { allowed: true });
});

test("existing provider operation may reconcile even when workspace is at operation limit", async () => {
  const db = buildOperationDb({
    existingOperation: {
      id: "op-existing",
      deployment_id: "deployment-a",
      status: "CREATE_REQUESTED",
      provider_resource_id: null,
      source_commit_sha: "a".repeat(40),
    },
    activeOperations: 99,
  });

  const result = await ensureBuildOperationWithinWorkspaceLimit(db, {
    id: "deployment-a",
    workspace_id: "workspace-a",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.createdNewOperation, false);
  assert.equal(result.operation.id, "op-existing");
  assert.equal(db.calls.some((call) => /count\(\*\)::int AS count\s+FROM deployment_provider_operations/.test(call.sql)), false);
});

test("new provider operation is refused before insert when workspace operation limit is reached", async () => {
  const db = buildOperationDb({ activeOperations: 1 });

  const result = await ensureBuildOperationWithinWorkspaceLimit(db, {
    id: "deployment-a",
    workspace_id: "workspace-a",
    status: "BUILDING",
    idempotency_key: "vercel:deployment:deployment-a:a",
    commit_sha: "a".repeat(40),
    provider_project_id: "prj_a",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision.code, "WORKSPACE_PROVIDER_OPERATION_LIMIT_REACHED");
  assert.equal(db.calls.some((call) => /INSERT INTO deployment_provider_operations/.test(call.sql)), false);
});

test("final provider operation slot is admitted once under workspace lock semantics", async () => {
  const db = buildOperationDb({ activeOperations: 0 });

  const result = await ensureBuildOperationWithinWorkspaceLimit(db, {
    id: "deployment-a",
    workspace_id: "workspace-a",
    status: "BUILDING",
    idempotency_key: "vercel:deployment:deployment-a:a",
    commit_sha: "a".repeat(40),
    provider_project_id: "prj_a",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.createdNewOperation, true);
  assert.equal(result.operation.id, "op-created");
  assert.ok(db.calls.find((call) => /SELECT id FROM workspaces/.test(call.sql) && /FOR UPDATE/.test(call.sql)));
});

test("founder policy override validates negative and unbounded values", () => {
  assert.deepEqual(validateWorkspaceResourcePolicy({
    maxActiveApps: 5,
    maxActiveDeployments: 6,
    maxActiveDeploymentsPerApp: 2,
    maxConcurrentProviderOperations: 3,
    maxManagedDatabases: 4,
  }), {
    maxActiveApps: 5,
    maxActiveDeployments: 6,
    maxActiveDeploymentsPerApp: 2,
    maxConcurrentProviderOperations: 3,
    maxManagedDatabases: 4,
  });
  assert.throws(
    () => validateWorkspaceResourcePolicy({ maxActiveApps: -1 }),
    WorkspaceResourcePolicyError,
  );
  assert.throws(
    () => validateWorkspaceResourcePolicy({ maxActiveDeployments: 1000 }),
    /maxActiveDeployments must be an integer between 0 and 100/,
  );

  const script = readControlPlaneFile("scripts/set-workspace-resource-policy.mjs");
  assert.match(script, /CONTROL_PLANE_WORKSPACE_ID/);
  assert.match(script, /validateWorkspaceResourcePolicy/);
  assert.doesNotMatch(script, /policy_tier|FREE|BUILDER|TEAM|BUSINESS/);
});

test("app creation and redeploy paths enforce deployment admission limits", () => {
  const createAppDeployment = readControlPlaneFile("scripts/create-app-deployment.mjs");
  const createRedeployment = readControlPlaneFile("trigger/create-redeployment.ts");

  assert.ok(
    createAppDeployment.indexOf("enforceDeploymentCreationLimit") < createAppDeployment.indexOf("INSERT INTO deployments"),
    "initial deployment admission must run before deployment insert",
  );
  assert.ok(
    createRedeployment.indexOf("enforceDeploymentCreationLimit") < createRedeployment.indexOf("INSERT INTO deployments"),
    "redeploy admission must run before redeployment insert",
  );
});

test("resource policy is verified before secret injection and provider build creation", () => {
  const orchestrator = readControlPlaneFile("trigger/orchestrate-deployment.ts");
  const executeBuild = readControlPlaneFile("trigger/execute-build.ts");

  assert.ok(
    orchestrator.indexOf("ssc-control-plane-enforce-resource-policy") < orchestrator.indexOf("ssc-control-plane-apply-runtime-env"),
    "orchestrator must verify resource policy before runtime secret application",
  );
  assert.ok(
    orchestrator.indexOf("ssc-control-plane-enforce-resource-policy") < orchestrator.indexOf("ssc-control-plane-execute-build"),
    "orchestrator must verify resource policy before provider build creation",
  );
  assert.ok(
    executeBuild.indexOf("ensureBuildOperation") < executeBuild.indexOf("vercelRequest(`/v13/deployments"),
    "provider operation quota/intent must run before Vercel deployment creation",
  );
});

test("workspace resource policy migration has no billing tiers and the managed database quota is explicit", () => {
  const migration = readControlPlaneFile("db/015_workspace_resource_policies.sql");
  const databaseMigration = readControlPlaneFile("db/016_managed_customer_databases.sql");

  assert.match(migration, /CREATE TABLE workspace_resource_policies/);
  assert.match(migration, /max_active_apps integer NOT NULL DEFAULT 3/);
  assert.match(migration, /max_active_deployments integer NOT NULL DEFAULT 3/);
  assert.match(migration, /max_active_deployments_per_app integer NOT NULL DEFAULT 1/);
  assert.match(migration, /max_concurrent_provider_operations integer NOT NULL DEFAULT 2/);
  assert.match(databaseMigration, /max_managed_databases integer NOT NULL DEFAULT 3/);
  assert.doesNotMatch(migration + databaseMigration, /policy_tier|tier|price|billing|max_database_storage/i);
});
