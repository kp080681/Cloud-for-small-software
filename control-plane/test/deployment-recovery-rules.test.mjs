import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReconciliationAction,
  healthAttemptAction,
  isRecoveryTerminalStatus,
  publicAccessRecoveryAction,
} from "../src/deployment-recovery-rules.mjs";
import {
  buildRecoveryAction,
  matchingSscDeployments,
  sscBuildOperationKey,
  sscDeploymentMeta,
} from "../src/vercel-deployment-recovery.mjs";
import {
  disableGitAutoDeploymentsBody,
  gitAutoDeploymentsDisabled,
} from "../src/vercel-project-config.mjs";
import { runtimeRecoveryAction } from "../src/vercel-runtime-recovery.mjs";

test("provider deployment with SSC metadata is attached instead of duplicated", () => {
  const identity = { deploymentId: "dep-1", sourceCommitSha: "a".repeat(40) };
  const deployments = [
    { id: "dpl_other", meta: sscDeploymentMeta({ deploymentId: "dep-2", sourceCommitSha: identity.sourceCommitSha }) },
    { id: "dpl_match", meta: sscDeploymentMeta(identity) },
  ];
  const matches = matchingSscDeployments(deployments, identity);
  const action = buildRecoveryAction({ matches, operationStatus: "CREATE_REQUESTED" });

  assert.equal(action.action, "attach");
  assert.equal(action.deployment.id, "dpl_match");
});

test("no matching provider deployment creates exactly one operation-scoped deployment", () => {
  const identity = { deploymentId: "dep-1", sourceCommitSha: "b".repeat(40) };
  const action = buildRecoveryAction({ matches: [], operationStatus: "INTENT_RECORDED" });

  assert.equal(action.action, "create");
  assert.equal(sscBuildOperationKey(identity), `vercel:deployment:${identity.deploymentId}:${identity.sourceCommitSha}`);
  assert.deepEqual(sscDeploymentMeta(identity), {
    sscDeploymentId: identity.deploymentId,
    sscSourceCommitSha: identity.sourceCommitSha,
  });
});

test("ambiguous matching provider deployments require explicit recovery", () => {
  const matches = [{ id: "dpl_1" }, { id: "dpl_2" }];
  const action = buildRecoveryAction({ matches, operationStatus: "CREATE_REQUESTED" });

  assert.deepEqual(action, { action: "ambiguous", count: 2 });
  assert.deepEqual(buildRecoveryAction({ matches: [], operationStatus: "AMBIGUOUS" }), {
    action: "ambiguous",
    count: 0,
  });
});

test("lost create response waits for provider visibility instead of creating a duplicate", () => {
  const action = buildRecoveryAction({ matches: [], operationStatus: "CREATE_REQUESTED" });

  assert.deepEqual(action, { action: "pending" });
});

test("remote runtime project without local runtime is reconciled", () => {
  assert.deepEqual(
    runtimeRecoveryAction({ localRuntime: null, remoteProject: { id: "prj_1", name: "ssc-demo" } }),
    { action: "reconcile-remote-project" },
  );
});

test("max health attempts exhausted fails instead of looping", () => {
  assert.deepEqual(
    healthAttemptAction({ existingAttemptCount: 3, maxAttempts: 3 }),
    { action: "fail-exhausted", attemptNumber: 4, attempts: 3 },
  );
});

test("provider build READY while local deployment is BUILDING advances once", () => {
  assert.deepEqual(
    buildReconciliationAction({ deploymentStatus: "BUILDING", providerStatus: "READY" }),
    { action: "advance-deploying" },
  );
  assert.deepEqual(
    buildReconciliationAction({ deploymentStatus: "DEPLOYING", providerStatus: "READY" }),
    { action: "pending" },
  );
});

test("public verification replay and terminal statuses do not move backward", () => {
  assert.deepEqual(publicAccessRecoveryAction("LIVE"), { action: "live-replay-noop" });
  assert.deepEqual(publicAccessRecoveryAction("FAILED"), { action: "terminal-noop" });
  assert.deepEqual(publicAccessRecoveryAction("HEALTH_CHECKING"), { action: "verify-public-access" });
  assert.equal(isRecoveryTerminalStatus("LIVE"), true);
  assert.equal(isRecoveryTerminalStatus("FAILED"), true);
  assert.equal(isRecoveryTerminalStatus("DELETED"), true);
  assert.equal(isRecoveryTerminalStatus("HEALTH_CHECKING"), false);
});

test("SSC-managed Vercel projects disable Git automatic deployments", () => {
  assert.deepEqual(disableGitAutoDeploymentsBody(), {
    git: {
      deploymentEnabled: false,
    },
  });
  assert.equal(gitAutoDeploymentsDisabled({ git: null, link: null }), true);
  assert.equal(gitAutoDeploymentsDisabled({}), true);
  assert.equal(gitAutoDeploymentsDisabled({ git: { deploymentEnabled: false } }), true);
  assert.equal(gitAutoDeploymentsDisabled({ git: { deploymentEnabled: true }, link: { type: "github" } }), false);
});
