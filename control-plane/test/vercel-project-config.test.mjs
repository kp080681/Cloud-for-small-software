import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  disableGitAutoDeploymentsBody,
  ensureGitAutoDeploymentsDisabled,
  GitAutoDeployContainment,
  gitAutoDeploymentState,
  gitAutoDeploymentsDisabled,
} from "../src/vercel-project-config.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("git auto-deploy state classifies disconnected, disabled, enabled, and unknown projects", () => {
  assert.equal(gitAutoDeploymentState({ git: null, link: null }), "disconnected");
  assert.equal(gitAutoDeploymentsDisabled({ git: null, link: null }), true);

  assert.equal(gitAutoDeploymentState({ git: { deploymentEnabled: false }, link: { type: "github" } }), "disabled");
  assert.equal(gitAutoDeploymentsDisabled({ git: { deploymentEnabled: false }, link: { type: "github" } }), true);

  assert.equal(gitAutoDeploymentState({ git: { deploymentEnabled: true }, link: { type: "github" } }), "enabled");
  assert.equal(gitAutoDeploymentsDisabled({ git: { deploymentEnabled: true }, link: { type: "github" } }), false);

  assert.equal(gitAutoDeploymentState({}), "unknown");
  assert.equal(gitAutoDeploymentsDisabled({}), false);
});

test("enabled new project is corrected and re-fetch verifies disabled", async () => {
  const calls = [];
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_1", git: { deploymentEnabled: true }, link: { type: "github" } },
    updateProject: async (projectId, body) => {
      calls.push({ projectId, body });
      return { id: projectId };
    },
    getProject: async (projectId) => ({ id: projectId, git: { deploymentEnabled: false }, link: { type: "github" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, GitAutoDeployContainment.CORRECTED);
  assert.deepEqual(calls, [{ projectId: "prj_1", body: disableGitAutoDeploymentsBody() }]);
});

test("provider update success but re-fetch still enabled fails closed", async () => {
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_1", git: { deploymentEnabled: true }, link: { type: "github" } },
    updateProject: async () => ({ id: "prj_1" }),
    getProject: async () => ({ id: "prj_1", git: { deploymentEnabled: true }, link: { type: "github" } }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.result, GitAutoDeployContainment.VERIFICATION_FAILED);
});

test("identity-valid adopted project with enabled auto-deploy requires correction before use", async () => {
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_adopted", git: { deploymentEnabled: true }, link: { type: "github" } },
    updateProject: async () => ({ id: "prj_adopted" }),
    getProject: async () => ({ id: "prj_adopted", git: { deploymentEnabled: false }, link: { type: "github" } }),
  });

  assert.equal(result.result, GitAutoDeployContainment.CORRECTED);
  assert.equal(result.ok, true);
});

test("adopted project cannot be used when provider correction fails", async () => {
  const error = new Error("forbidden");
  error.status = 403;
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_adopted", git: { deploymentEnabled: true }, link: { type: "github" } },
    updateProject: async () => {
      throw error;
    },
    getProject: async () => {
      throw new Error("should not refetch after failed update");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.result, GitAutoDeployContainment.PROVIDER_UNSUPPORTED);
  assert.equal(result.providerHttpStatus, 403);
});

test("legacy runtime with disabled auto-deploy passes without mutation", async () => {
  let updateCalled = false;
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_legacy", git: { deploymentEnabled: false }, link: { type: "github" } },
    updateProject: async () => {
      updateCalled = true;
    },
    getProject: async () => {
      throw new Error("should not refetch when already disabled");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, GitAutoDeployContainment.ALREADY_DISABLED);
  assert.equal(updateCalled, false);
});

test("legacy runtime drifted back to enabled must be corrected before build", async () => {
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_legacy", git: { deploymentEnabled: true }, link: { type: "github" } },
    updateProject: async () => ({ id: "prj_legacy" }),
    getProject: async () => ({ id: "prj_legacy", git: { deploymentEnabled: false }, link: { type: "github" } }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, GitAutoDeployContainment.CORRECTED);
});

test("provider response omitting Git state is unknown and not treated as disabled", async () => {
  const result = await ensureGitAutoDeploymentsDisabled({
    project: { id: "prj_unknown" },
    updateProject: async () => ({ id: "prj_unknown" }),
    getProject: async () => ({ id: "prj_unknown" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.result, GitAutoDeployContainment.VERIFICATION_FAILED);
  assert.equal(result.state, "unknown");
});

test("SSC production paths enforce Git auto-deploy containment before secrets and build create", () => {
  const provisionRuntime = fs.readFileSync(path.join(root, "trigger/provision-runtime.ts"), "utf8");
  const applyRuntimeEnv = fs.readFileSync(path.join(root, "trigger/apply-runtime-env.ts"), "utf8");
  const executeBuild = fs.readFileSync(path.join(root, "trigger/execute-build.ts"), "utf8");

  assert.match(provisionRuntime, /ensureGitAutoDeploymentsDisabled/);
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
    executeBuild.indexOf("enforceGitAutoDeployments") < executeBuild.indexOf("ensureBuildOperation"),
    "build execution must verify Git auto-deploy containment before provider deployment intent/create",
  );
  assert.match(executeBuild, /vercelRequest\(`\/v13\/deployments/);
});
