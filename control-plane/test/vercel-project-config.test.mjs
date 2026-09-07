import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ensureGitAutoDeploymentsDisabled,
  GitAutoDeployContainment,
  gitAutoDeploymentState,
  gitAutoDeploymentsDisabled,
} from "../src/vercel-project-config.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("git auto-deploy state classifies only disconnected projects as safe", () => {
  assert.equal(gitAutoDeploymentState({ git: null, link: null }), "disconnected");
  assert.equal(gitAutoDeploymentsDisabled({ git: null, link: null }), true);

  assert.equal(gitAutoDeploymentState({ git: null, link: { type: "github" } }), "connected");
  assert.equal(gitAutoDeploymentsDisabled({ git: null, link: { type: "github" } }), false);

  assert.equal(gitAutoDeploymentState({ git: { deploymentEnabled: false }, link: { type: "github" } }), "connected");
  assert.equal(gitAutoDeploymentsDisabled({ git: { deploymentEnabled: false }, link: { type: "github" } }), false);

  assert.equal(gitAutoDeploymentState({ git: { deploymentEnabled: true }, link: { type: "github" } }), "connected");
  assert.equal(gitAutoDeploymentsDisabled({ git: { deploymentEnabled: true }, link: { type: "github" } }), false);

  assert.equal(gitAutoDeploymentState({}), "unknown");
  assert.equal(gitAutoDeploymentsDisabled({}), false);
});

test("disconnected project passes without provider mutation", async () => {
  let updateCalled = false;
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_1", git: null, link: null },
    updateProject: async () => {
      updateCalled = true;
    },
    getProject: async () => {
      throw new Error("should not refetch disconnected project");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, GitAutoDeployContainment.ALREADY_DISCONNECTED);
  assert.equal(updateCalled, false);
});

test("connected project requires manual disconnect and is not patched", async () => {
  let updateCalled = false;
  let refetchCalled = false;
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_1", git: null, link: { type: "github", repo: "kp080681/ssc-lifecycle-test" } },
    updateProject: async () => {
      updateCalled = true;
    },
    getProject: async () => {
      refetchCalled = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.result, GitAutoDeployContainment.ACTION_REQUIRED);
  assert.equal(result.reason, "connected-git-requires-manual-disconnect");
  assert.equal(updateCalled, false);
  assert.equal(refetchCalled, false);
});

test("deploymentEnabled false on a connected project still requires disconnect", async () => {
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_connected", git: { deploymentEnabled: false }, link: { type: "github" } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.result, GitAutoDeployContainment.ACTION_REQUIRED);
});

test("unknown project Git state is blocked without provider mutation", async () => {
  let updateCalled = false;
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_unknown" },
    updateProject: async () => {
      updateCalled = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.result, GitAutoDeployContainment.UNKNOWN);
  assert.equal(result.state, "unknown");
  assert.equal(updateCalled, false);
});

test("unsupported deploymentEnabled PATCH is no longer represented as successful containment", async () => {
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_enabled", git: { deploymentEnabled: true }, link: { type: "github" } },
    updateProject: async () => {
      throw new Error("unsupported provider patch must not be attempted");
    },
  });

  assert.equal(result.ok, false);
  assert.notEqual(result.result, GitAutoDeployContainment.DISCONNECTED);
  assert.equal(result.corrected, false);
});

test("SSC production paths enforce Git auto-deploy containment before secrets and build create", () => {
  const provisionRuntime = fs.readFileSync(path.join(root, "trigger/provision-runtime.ts"), "utf8");
  const applyRuntimeEnv = fs.readFileSync(path.join(root, "trigger/apply-runtime-env.ts"), "utf8");
  const executeBuild = fs.readFileSync(path.join(root, "trigger/execute-build.ts"), "utf8");

  assert.match(provisionRuntime, /ensureGitAutoDeploymentsDisabled/);
  assert.doesNotMatch(
    provisionRuntime,
    /gitRepository:\s*\{/,
    "runtime project creation must not create project-level Git linkage",
  );
  assert.ok(
    provisionRuntime.indexOf("enforceRuntimeGitAutoDeployments") < provisionRuntime.indexOf("INSERT INTO app_runtimes"),
    "runtime provisioning must verify Git auto-deploy containment before local runtime attachment",
  );

  assert.match(applyRuntimeEnv, /ensureGitAutoDeploymentsDisabled/);
  assert.ok(
    applyRuntimeEnv.indexOf("enforceGitAutoDeployments(remoteProject)") < applyRuntimeEnv.indexOf("const plaintext = await decryptAppSecret"),
    "runtime env application must verify Git auto-deploy containment before decrypting secrets",
  );

  assert.match(executeBuild, /ensureGitAutoDeploymentsDisabled/);
  assert.ok(
    executeBuild.indexOf("await enforceGitAutoDeployments(remoteProject)") < executeBuild.indexOf("const operationResult=await ensureBuildOperation"),
    "build execution must verify Git auto-deploy containment before provider deployment intent/create",
  );
  assert.match(executeBuild, /vercelRequest\(`\/v13\/deployments/);
});
