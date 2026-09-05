import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertAppInWorkspace,
  assertDeploymentBelongsToApp,
  assertDeploymentInWorkspace,
  assertProviderBuildBelongsToDeployment,
  assertProviderOperationBelongsToDeployment,
  assertRepositoryInWorkspace,
  assertRuntimeBelongsToApp,
  assertRuntimeMatchesDeployment,
  assertSecretBindingBelongsToApp,
  assertSscProviderResourceIdentity,
} from "../src/tenant-boundary.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const workspaceA = { id: "workspace-a" };
const workspaceB = { id: "workspace-b" };

const repoA = { id: "repo-a", workspaceId: workspaceA.id, fullName: "owner/repo-a" };
const repoB = { id: "repo-b", workspaceId: workspaceB.id, fullName: "owner/repo-b" };

const appA = { id: "app-a", workspaceId: workspaceA.id, repositoryId: repoA.id };
const appB = { id: "app-b", workspaceId: workspaceB.id, repositoryId: repoB.id };

const deploymentA = {
  id: "deployment-a",
  workspaceId: workspaceA.id,
  appId: appA.id,
  runtimeProjectId: "runtime-a",
  sourceCommitSha: "a".repeat(40),
};
const deploymentB = {
  id: "deployment-b",
  workspaceId: workspaceB.id,
  appId: appB.id,
  runtimeProjectId: "runtime-b",
  sourceCommitSha: "b".repeat(40),
};

const runtimeA = {
  id: "runtime-row-a",
  runtimeAppId: appA.id,
  runtimeWorkspaceId: workspaceA.id,
  providerProjectId: "runtime-a",
};
const runtimeB = {
  id: "runtime-row-b",
  runtimeAppId: appB.id,
  runtimeWorkspaceId: workspaceB.id,
  providerProjectId: "runtime-b",
};

const secretBindingA = {
  bindingId: "binding-a",
  bindingWorkspaceId: workspaceA.id,
  bindingAppId: appA.id,
  secretId: "secret-a",
  secretWorkspaceId: workspaceA.id,
  secretAppId: appA.id,
};
const secretBindingB = {
  bindingId: "binding-b",
  bindingWorkspaceId: workspaceB.id,
  bindingAppId: appB.id,
  secretId: "secret-b",
  secretWorkspaceId: workspaceB.id,
  secretAppId: appB.id,
};

test("workspace ownership assertions accept same-tenant app, repository, and deployment", () => {
  assert.equal(assertAppInWorkspace(appA, workspaceA.id), appA);
  assert.equal(assertRepositoryInWorkspace(repoA, workspaceA.id), repoA);
  assert.equal(assertDeploymentInWorkspace(deploymentA, workspaceA.id), deploymentA);
  assert.equal(assertDeploymentBelongsToApp(deploymentA, appA), deploymentA);
});

test("workspace ownership assertions reject cross-tenant app, repository, and deployment", () => {
  assert.throws(() => assertAppInWorkspace(appA, workspaceB.id), /App does not belong/);
  assert.throws(() => assertRepositoryInWorkspace(repoA, workspaceB.id), /Repository does not belong/);
  assert.throws(() => assertDeploymentInWorkspace(deploymentA, workspaceB.id), /Deployment does not belong/);
  assert.throws(() => assertDeploymentBelongsToApp(deploymentA, appB), /Deployment does not belong/);
});

test("repository from workspace A cannot be used as workspace B ownership evidence", () => {
  assert.throws(() => assertRepositoryInWorkspace(repoA, appB.workspaceId), /Repository does not belong/);
  assert.equal(assertRepositoryInWorkspace(repoB, appB.workspaceId), repoB);
});

test("secret A cannot be bound or injected into app B", () => {
  assert.equal(assertSecretBindingBelongsToApp(secretBindingA, appA), secretBindingA);
  assert.equal(assertSecretBindingBelongsToApp(secretBindingB, appB), secretBindingB);

  assert.throws(
    () => assertSecretBindingBelongsToApp(secretBindingA, appB),
    /Secret binding does not belong|Secret does not belong|Secret workspace/,
  );
  assert.throws(
    () => assertSecretBindingBelongsToApp({ ...secretBindingB, secretAppId: appA.id, secretWorkspaceId: workspaceA.id }, appB),
    /Secret does not belong/,
  );
});

test("runtime A cannot be attached to app or deployment B", () => {
  assert.equal(assertRuntimeBelongsToApp(runtimeA, appA), runtimeA);
  assert.equal(assertRuntimeMatchesDeployment(runtimeA, deploymentA), runtimeA);

  assert.throws(() => assertRuntimeBelongsToApp(runtimeA, appB), /Runtime does not belong|Runtime workspace/);
  assert.throws(() => assertRuntimeMatchesDeployment(runtimeA, deploymentB), /runtime project binding|Runtime app|Runtime workspace/);
});

test("provider build A cannot be attached to deployment B", () => {
  const buildA = {
    deploymentId: deploymentA.id,
    sourceCommitSha: deploymentA.sourceCommitSha,
    providerDeploymentId: "dpl-a",
  };

  assert.equal(assertProviderBuildBelongsToDeployment(buildA, deploymentA), buildA);
  assert.throws(() => assertProviderBuildBelongsToDeployment(buildA, deploymentB), /Provider build does not belong/);
  assert.throws(
    () => assertProviderBuildBelongsToDeployment({ ...buildA, deploymentId: deploymentB.id }, deploymentB),
    /source identity/,
  );
});

test("provider operation A cannot recover deployment B", () => {
  const operationA = {
    deploymentId: deploymentA.id,
    sourceCommitSha: deploymentA.sourceCommitSha,
    providerResourceId: "dpl-a",
  };

  assert.equal(assertProviderOperationBelongsToDeployment(operationA, deploymentA), operationA);
  assert.throws(() => assertProviderOperationBelongsToDeployment(operationA, deploymentB), /Provider operation does not belong/);
  assert.throws(
    () => assertProviderOperationBelongsToDeployment({ ...operationA, deploymentId: deploymentB.id }, deploymentB),
    /source identity/,
  );
});

test("SSC provider metadata must match deployment id and source identity", () => {
  const resourceA = {
    id: "dpl-a",
    meta: {
      sscDeploymentId: deploymentA.id,
      sscSourceCommitSha: deploymentA.sourceCommitSha,
    },
  };

  assert.equal(assertSscProviderResourceIdentity(resourceA, deploymentA), resourceA);
  assert.throws(() => assertSscProviderResourceIdentity(resourceA, deploymentB), /SSC deployment identity/);
  assert.throws(
    () => assertSscProviderResourceIdentity({
      ...resourceA,
      meta: { ...resourceA.meta, sscDeploymentId: deploymentB.id },
    }, deploymentB),
    /SSC source identity/,
  );
});

test("secret inventory and runtime injection require same-app same-workspace secret joins", () => {
  const runtimeEnv = readControlPlaneFile("trigger/apply-runtime-env.ts");
  const secretInventory = readControlPlaneFile("scripts/list-app-secrets.mjs");

  for (const source of [runtimeEnv, secretInventory]) {
    assert.match(source, /s\.id = b\.secret_id/);
    assert.match(source, /s\.workspace_id = b\.workspace_id/);
    assert.match(source, /s\.app_id = b\.app_id/);
  }
});

test("production build preparation verifies repository workspace before source reads", () => {
  const prepareBuildInput = readControlPlaneFile("trigger/prepare-build-input.ts");
  const detectEnvRequirements = readControlPlaneFile("trigger/detect-env-requirements.ts");

  assert.match(prepareBuildInput, /assertRepositoryInWorkspace/);
  assert.ok(
    prepareBuildInput.indexOf("assertRepositoryInWorkspace") < prepareBuildInput.indexOf("octokit.git.getCommit"),
    "prepare-build-input must validate repository workspace before GitHub source reads",
  );
  assert.match(detectEnvRequirements, /assertRepositoryInWorkspace/);
  assert.match(detectEnvRequirements, /Build input repository does not match app repository/);
  assert.ok(
    detectEnvRequirements.indexOf("assertRepositoryInWorkspace") < detectEnvRequirements.indexOf("octokit.git.getTree"),
    "detect-env-requirements must validate repository workspace before GitHub source tree reads",
  );
});

test("production build execution verifies runtime and operation ownership before provider mutation", () => {
  const executeBuild = readControlPlaneFile("trigger/execute-build.ts");

  assert.match(executeBuild, /assertRuntimeMatchesDeployment/);
  assert.match(executeBuild, /assertProviderOperationBelongsToDeployment/);
  assert.ok(
    executeBuild.indexOf("assertRuntimeMatchesDeployment") < executeBuild.indexOf("ensureBuildOperation"),
    "execute-build must validate runtime ownership before provider operation intent",
  );
  assert.ok(
    executeBuild.indexOf("assertProviderOperationBelongsToDeployment") < executeBuild.indexOf("vercelRequest(`/v13/deployments"),
    "execute-build must validate provider operation ownership before Vercel deployment creation",
  );
});

test("production provider deployment attachment requires SSC metadata before local attach", () => {
  const executeBuild = readControlPlaneFile("trigger/execute-build.ts");
  const reconcileBuild = readControlPlaneFile("trigger/reconcile-build.ts");

  assert.match(executeBuild, /assertSscProviderResourceIdentity/);
  assert.ok(
    executeBuild.indexOf("assertSscProviderResourceIdentity") < executeBuild.indexOf("INSERT INTO deployment_builds"),
    "execute-build must verify provider deployment metadata before local build attachment",
  );

  assert.match(reconcileBuild, /assertProviderBuildBelongsToDeployment/);
  assert.match(reconcileBuild, /assertSscProviderResourceIdentity/);
  assert.ok(
    reconcileBuild.indexOf("assertProviderBuildBelongsToDeployment") < reconcileBuild.indexOf("getVercelDeployment"),
    "reconcile-build must verify local build ownership before provider lookup",
  );
  assert.ok(
    reconcileBuild.indexOf("assertSscProviderResourceIdentity") < reconcileBuild.indexOf("UPDATE deployment_builds"),
    "reconcile-build must verify provider deployment metadata before state mutation",
  );
});
