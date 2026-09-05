import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertProviderProjectNotOwnedByAnotherApp,
  assertRemoteProjectMatchesSscApp,
  legacySlugProviderProjectName,
  providerProjectOwnership,
  sscProviderProjectName,
} from "../src/provider-project-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("same slug in different workspaces resolves to different provider project names", () => {
  const appA = { workspaceId: "aaaaaaaa-0000-4000-8000-000000000000", appId: "11111111-1111-4111-8111-111111111111", slug: "dashboard" };
  const appB = { workspaceId: "bbbbbbbb-0000-4000-8000-000000000000", appId: "22222222-2222-4222-8222-222222222222", slug: "dashboard" };

  const nameA = sscProviderProjectName(appA);
  const nameB = sscProviderProjectName(appB);

  assert.notEqual(nameA, nameB);
  assert.equal(nameA, "ssc-aaaaaaaa0000-111111111111-dashboard");
  assert.equal(nameB, "ssc-bbbbbbbb0000-222222222222-dashboard");
  assert.ok(nameA.length <= 80);
  assert.ok(nameB.length <= 80);
});

test("remote project with expected name but another SSC app identity is refused", () => {
  const appA = { workspaceId: "aaaaaaaa-0000-4000-8000-000000000000", appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "dashboard" };
  const appB = { workspaceId: "bbbbbbbb-0000-4000-8000-000000000000", appId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", slug: "dashboard" };
  const remoteForA = {
    id: "prj_a",
    name: sscProviderProjectName(appA),
  };

  assert.throws(
    () => assertRemoteProjectMatchesSscApp(remoteForA, appB),
    /Provider project identity does not match SSC app ownership/,
  );
});

test("local provider project id already owned by another app is refused", () => {
  assert.throws(
    () => assertProviderProjectNotOwnedByAnotherApp([
      { app_id: "app-a", provider_project_id: "prj_same" },
      { app_id: "app-b", provider_project_id: "prj_same" },
    ], { appId: "app-b", providerProjectId: "prj_same" }),
    /Provider project is already owned by another SSC app/,
  );
});

test("existing same-app runtime ownership is accepted", () => {
  assert.doesNotThrow(() => assertProviderProjectNotOwnedByAnotherApp([
    { app_id: "app-a", provider_project_id: "prj_same" },
  ], { appId: "app-a", providerProjectId: "prj_same" }));
});

test("legacy stored provider id can be reused only for same-app local binding", () => {
  const app = { workspaceId: "cccccccc-0000-4000-8000-000000000000", appId: "33333333-3333-4333-8333-333333333333", slug: "dealup" };
  const storedProjectName = legacySlugProviderProjectName(app.slug);
  const remoteLegacyProject = { id: "prj_legacy", name: storedProjectName };

  assert.equal(
    assertRemoteProjectMatchesSscApp(remoteLegacyProject, {
      ...app,
      storedProjectName,
      allowLegacyStoredBinding: true,
    }),
    remoteLegacyProject,
  );
  assert.throws(
    () => assertRemoteProjectMatchesSscApp(remoteLegacyProject, app),
    /Provider project identity does not match SSC app ownership/,
  );
});

test("provider ownership exposes expected and legacy names for migration handling", () => {
  assert.deepEqual(providerProjectOwnership({
    workspaceId: "dddddddd-0000-4000-8000-000000000000",
    appId: "44444444-4444-4444-8444-444444444444",
    slug: "My App!",
  }), {
    expectedName: "ssc-dddddddd0000-444444444444-my-app",
    legacyName: "ssc-my-app",
    storedProjectName: null,
  });
});

test("provider project uniqueness migration protects local ownership", () => {
  const migration = readControlPlaneFile("db/014_provider_project_identity.sql");

  assert.match(migration, /CREATE UNIQUE INDEX app_runtimes_provider_project_unique_idx/);
  assert.match(migration, /ON app_runtimes \(provider, provider_project_id\)/);
  assert.match(migration, /WHERE provider_project_id IS NOT NULL/);
});

test("production paths require runtime provider identity before sensitive provider operations", () => {
  const applyRuntimeEnv = readControlPlaneFile("trigger/apply-runtime-env.ts");
  const executeBuild = readControlPlaneFile("trigger/execute-build.ts");
  const deleteApp = readControlPlaneFile("trigger/delete-app.ts");
  const provisionRuntime = readControlPlaneFile("trigger/provision-runtime.ts");

  assert.match(provisionRuntime, /sscProviderProjectName/);
  assert.match(provisionRuntime, /assertRemoteProjectMatchesSscApp/);
  assert.match(provisionRuntime, /assertProviderProjectNotOwnedByAnotherApp/);

  assert.ok(
    applyRuntimeEnv.indexOf("assertRemoteProjectMatchesSscApp") < applyRuntimeEnv.indexOf("const bindingResult"),
    "apply-runtime-env must verify provider identity before reading bindings/decrypting secrets",
  );
  assert.ok(
    executeBuild.indexOf("assertRemoteProjectMatchesSscApp") < executeBuild.indexOf("ensureBuildOperation"),
    "execute-build must verify provider identity before build operation/create",
  );
  assert.ok(
    deleteApp.indexOf("assertRemoteProjectMatchesSscApp") < deleteApp.indexOf("deleteVercelProject"),
    "delete-app must verify provider identity before provider deletion",
  );
});
