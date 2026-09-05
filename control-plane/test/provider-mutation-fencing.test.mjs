import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildRecoveryAction } from "../src/vercel-deployment-recovery.mjs";
import {
  buildResultAttachmentDecision,
  claimProviderCreateOperation,
  providerCreateClaimDecision,
  runtimeResultAttachmentDecision,
} from "../src/provider-mutation-fencing.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function operationDb(initialOperations) {
  const operations = new Map(initialOperations.map((operation) => [operation.id, { ...operation }]));
  return {
    operations,
    async query(sql, params) {
      if (/UPDATE deployment_provider_operations/.test(sql)) {
        const operation = operations.get(params[0]);
        if (
          operation &&
          ["INTENT_RECORDED", "FAILED"].includes(operation.status) &&
          operation.provider_resource_id == null
        ) {
          operation.status = "CREATE_REQUESTED";
          return { rowCount: 1, rows: [{ ...operation }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT id, deployment_id, status, provider_resource_id, source_commit_sha/.test(sql)) {
        const operation = operations.get(params[0]);
        return operation ? { rowCount: 1, rows: [{ ...operation }] } : { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL in provider mutation fencing test: ${sql}`);
    },
  };
}

test("unfenced build recovery decision reproduces duplicate provider create count before fix", () => {
  const first = buildRecoveryAction({ matches: [], operationStatus: "INTENT_RECORDED" });
  const second = buildRecoveryAction({ matches: [], operationStatus: "INTENT_RECORDED" });

  const providerCreateCallCountBefore = [first, second].filter((action) => action.action === "create").length;

  assert.equal(providerCreateCallCountBefore, 2);
});

test("atomic provider operation claim permits exactly one creator", async () => {
  const db = operationDb([
    {
      id: "op-a",
      deployment_id: "deployment-a",
      status: "INTENT_RECORDED",
      provider_resource_id: null,
      source_commit_sha: "a".repeat(40),
    },
  ]);

  const [first, second] = await Promise.all([
    claimProviderCreateOperation(db, { operationId: "op-a" }),
    claimProviderCreateOperation(db, { operationId: "op-a" }),
  ]);
  const providerCreateCallCountAfter = [first, second].filter((claim) => claim.claimed).length;

  assert.equal(providerCreateCallCountAfter, 1);
  assert.equal(db.operations.get("op-a").status, "CREATE_REQUESTED");
});

test("already-owned provider create claim does not create again", () => {
  assert.deepEqual(
    providerCreateClaimDecision({ status: "CREATE_REQUESTED", provider_resource_id: null }),
    { action: "in-flight", claimed: false },
  );
  assert.deepEqual(
    providerCreateClaimDecision({ status: "OBSERVED", provider_resource_id: "dpl_1" }),
    { action: "observed", claimed: false },
  );
});

test("provider response loss still reconciles by SSC metadata without duplicate create", () => {
  const existingProviderDeployment = {
    id: "dpl_existing",
    meta: {
      sscDeploymentId: "deployment-a",
      sscSourceCommitSha: "a".repeat(40),
    },
  };

  const action = buildRecoveryAction({
    matches: [existingProviderDeployment],
    operationStatus: "CREATE_REQUESTED",
  });

  assert.equal(action.action, "attach");
  assert.equal(action.deployment, existingProviderDeployment);
});

test("stale build worker traces provider result instead of attaching after terminal state", () => {
  assert.deepEqual(
    buildResultAttachmentDecision({ deploymentStatus: "FAILED", operationStatus: "CREATE_REQUESTED" }),
    { action: "trace-stale", reason: "deployment_status_FAILED" },
  );
  assert.deepEqual(
    buildResultAttachmentDecision({ deploymentStatus: "BUILDING", operationStatus: "CREATE_REQUESTED" }),
    { action: "attach" },
  );
});

test("stale provision worker traces runtime result instead of reviving deleted app", () => {
  assert.deepEqual(
    runtimeResultAttachmentDecision({ appDeletedAt: new Date(), deploymentStatus: "DELETING" }),
    { action: "trace-stale", reason: "app_deleted" },
  );
  assert.deepEqual(
    runtimeResultAttachmentDecision({ appDeletedAt: null, deploymentStatus: "PROVISIONING" }),
    { action: "attach" },
  );
});

test("different app/deployment operations can claim independently", async () => {
  const db = operationDb([
    { id: "op-a", deployment_id: "deployment-a", status: "INTENT_RECORDED", provider_resource_id: null, source_commit_sha: "a".repeat(40) },
    { id: "op-b", deployment_id: "deployment-b", status: "INTENT_RECORDED", provider_resource_id: null, source_commit_sha: "b".repeat(40) },
  ]);

  const [first, second] = await Promise.all([
    claimProviderCreateOperation(db, { operationId: "op-a" }),
    claimProviderCreateOperation(db, { operationId: "op-b" }),
  ]);

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, true);
});

test("production paths use atomic claim and stale-result fencing before provider/state mutation", () => {
  const executeBuild = readControlPlaneFile("trigger/execute-build.ts");
  const provisionRuntime = readControlPlaneFile("trigger/provision-runtime.ts");
  const deleteApp = readControlPlaneFile("trigger/delete-app.ts");
  const abandonDeployment = readControlPlaneFile("trigger/abandon-deployment.ts");

  assert.match(executeBuild, /claimProviderCreateOperation/);
  assert.match(executeBuild, /buildResultAttachmentDecision/);
  assert.ok(
    executeBuild.indexOf("claimProviderCreateOperation") < executeBuild.indexOf("vercelRequest(`/v13/deployments"),
    "execute-build must claim before Vercel create",
  );
  assert.ok(
    executeBuild.indexOf("buildResultAttachmentDecision") < executeBuild.indexOf("INSERT INTO deployment_builds"),
    "execute-build must fence stale provider result before local build attachment",
  );

  assert.match(provisionRuntime, /runtimeResultAttachmentDecision/);
  assert.ok(
    provisionRuntime.indexOf("runtimeResultAttachmentDecision") < provisionRuntime.indexOf("INSERT INTO app_runtimes"),
    "provision-runtime must fence stale provider result before local runtime insertion",
  );

  assert.match(deleteApp, /FOR UPDATE OF a/);
  assert.ok(
    deleteApp.indexOf("BEGIN") < deleteApp.indexOf("FOR UPDATE OF a"),
    "delete-app must lock app lifecycle inside a transaction before marking deleting",
  );

  assert.ok(
    abandonDeployment.indexOf("BEGIN") < abandonDeployment.indexOf("FOR UPDATE"),
    "abandon-deployment must lock deployment inside a transaction",
  );
});
