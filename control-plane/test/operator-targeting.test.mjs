import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertResolvedAppTarget,
  requireAppSlug,
  requireWorkspaceId,
  resolveAppTarget,
} from "../src/operator-targeting.mjs";

const root = path.resolve(import.meta.dirname, "..");
const workspaceA = "aaaaaaaa-0000-4000-8000-000000000000";
const workspaceB = "bbbbbbbb-0000-4000-8000-000000000000";
const appA = "11111111-1111-4111-8111-111111111111";
const appB = "22222222-2222-4222-8222-222222222222";

function script(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function mockDb(rows) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: rows.length, rows };
    },
  };
}

test("workspace-scoped same-slug targeting selects only the requested workspace app", async () => {
  const db = mockDb([{ id: appB, workspace_id: workspaceB, slug: "api", deleted_at: null }]);

  const app = await resolveAppTarget(db, { workspaceId: workspaceB, slug: "api" });

  assert.equal(app.id, appB);
  assert.deepEqual(db.queries[0].params, [workspaceB, "api"]);
  assert.match(db.queries[0].sql, /workspace_id = \$1/);
  assert.match(db.queries[0].sql, /lower\(slug\) = lower\(\$2\)/);
});

test("slug targeting without workspace is refused before database lookup", async () => {
  const db = mockDb([{ id: appB, workspace_id: workspaceB, slug: "api" }]);

  await assert.rejects(
    () => resolveAppTarget(db, { slug: "api" }),
    /requires workspaceId/,
  );
  assert.equal(db.queries.length, 0);
});

test("delete-style includeDeleted lookup remains workspace scoped", async () => {
  const db = mockDb([{ id: appB, workspace_id: workspaceB, slug: "api", deleted_at: null }]);

  const app = await resolveAppTarget(db, { workspaceId: workspaceB, slug: "api", includeDeleted: true });

  assert.equal(app.id, appB);
  assert.doesNotMatch(db.queries[0].sql, /deleted_at IS NULL/);
  assert.match(db.queries[0].sql, /workspace_id = \$1/);
});

test("appId belonging to another workspace is refused", () => {
  assert.throws(
    () => assertResolvedAppTarget(
      [{ id: appA, workspace_id: workspaceA, slug: "api" }],
      { workspaceId: workspaceB, appId: appA },
    ),
    /workspace mismatch/,
  );
});

test("workspace and slug resolving no app is refused", () => {
  assert.throws(
    () => assertResolvedAppTarget([], { workspaceId: workspaceB, slug: "api" }),
    /not found/,
  );
});

test("workspace, appId, and slug mismatch is refused", () => {
  assert.throws(
    () => assertResolvedAppTarget(
      [{ id: appB, workspace_id: workspaceB, slug: "billing" }],
      { workspaceId: workspaceB, appId: appB, slug: "api" },
    ),
    /slug mismatch/,
  );
});

test("read-only ambiguous slug lookup is refused, never silently selected", () => {
  assert.throws(
    () => assertResolvedAppTarget(
      [
        { id: appA, workspace_id: workspaceB, slug: "api" },
        { id: appB, workspace_id: workspaceB, slug: "api" },
      ],
      { workspaceId: workspaceB, slug: "api" },
    ),
    /Ambiguous app target/,
  );
});

test("existing legitimate single-workspace operator flow passes", async () => {
  const db = mockDb([{ id: appA, workspace_id: workspaceA, slug: "vantage", deleted_at: null }]);

  const app = await resolveAppTarget(db, { workspaceId: workspaceA, appId: appA, slug: "vantage" });

  assert.equal(app.id, appA);
  assert.match(db.queries[0].sql, /id = \$2/);
  assert.match(db.queries[0].sql, /lower\(slug\) = lower\(\$3\)/);
});

test("mutating operator scripts require workspace-scoped targeting", () => {
  for (const relativePath of [
    "scripts/set-app-secret.mjs",
    "scripts/import-env-file.mjs",
    "scripts/store-app-secret.mjs",
    "scripts/run-delete-app.mjs",
    "scripts/run-redeploy.mjs",
    "scripts/create-app-deployment.mjs",
    "scripts/map-github-repository.mjs",
    "scripts/seed-vantage-env-requirements.mjs",
  ]) {
    const text = script(relativePath);
    assert.match(text, /requireWorkspaceId/);
    assert.doesNotMatch(text, /WHERE\s+lower\(slug\)\s*=\s*lower\(\$1\)\s+LIMIT 1/i);
    assert.doesNotMatch(text, /WHERE\s+slug\s*=\s*\$1\s+AND\s+deleted_at\s+IS\s+NULL\s+LIMIT 1/i);
  }
});

test("secret-bearing operator scripts resolve app target before accepting plaintext input", () => {
  const setSecret = script("scripts/set-app-secret.mjs");
  const importEnv = script("scripts/import-env-file.mjs");
  const storeSecret = script("scripts/store-app-secret.mjs");

  assert.ok(
    setSecret.indexOf("resolveAppTarget") < setSecret.indexOf("CONTROL_PLANE_SECRET_VALUE"),
    "set-app-secret must resolve tenant/app before accepting plaintext secret value",
  );
  assert.ok(
    importEnv.indexOf("resolveAppTarget") < importEnv.indexOf("raw = await fs.readFile"),
    "import-env-file must resolve tenant/app before reading plaintext env file",
  );
  assert.ok(
    storeSecret.indexOf("resolveAppTarget") < storeSecret.indexOf("CONTROL_PLANE_SECRET_VALUE"),
    "store-app-secret must resolve tenant/app before accepting plaintext secret value",
  );
  assert.doesNotMatch(setSecret, /CONTROL_PLANE_SECRET_VALUE\)\.digest/);
  assert.doesNotMatch(setSecret, /\bdigest,/);
});

test("deployment runner scripts accept immutable deployment id or workspace-scoped app target", () => {
  for (const relativePath of [
    "scripts/run-apply-runtime-env.mjs",
    "scripts/run-detect-env-requirements.mjs",
    "scripts/run-execute-build.mjs",
    "scripts/run-orchestrator.mjs",
    "scripts/run-prepare-build-input.mjs",
    "scripts/run-provision-runtime.mjs",
    "scripts/run-public-access.mjs",
    "scripts/run-resource-policy.mjs",
    "scripts/run-verify-env-requirements.mjs",
  ]) {
    const text = script(relativePath);
    assert.match(text, /optionalDeploymentId/);
    assert.match(text, /resolveDeploymentTarget/);
    assert.match(text, /resolveLatestDeploymentForAppTarget/);
    assert.doesNotMatch(text, /ORDER BY d\.created_at DESC\s+LIMIT 1`?,\s*\[\s*appSlug\s*\]/);
  }
});

test("workspace and slug environment parsing refuses implicit default slugs", () => {
  assert.equal(requireWorkspaceId({ CONTROL_PLANE_WORKSPACE_ID: workspaceA }), workspaceA);
  assert.equal(requireAppSlug({ CONTROL_PLANE_APP_SLUG: "api" }), "api");
  assert.throws(() => requireWorkspaceId({}), /CONTROL_PLANE_WORKSPACE_ID/);
  assert.throws(() => requireAppSlug({}), /CONTROL_PLANE_APP_SLUG/);
});
