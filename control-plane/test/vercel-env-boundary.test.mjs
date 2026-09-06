import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SSC_ALPHA_ENV_TARGETS,
  assertVercelEnvUpsertSucceeded,
  isPublicEnvironmentKey,
  providerEnvId,
  providerEnvTargets,
  vercelProjectEnvPayload,
} from "../src/vercel-env-boundary.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("new customer secret targets production only", () => {
  const payload = vercelProjectEnvPayload({ envKey: "DATABASE_URL", plaintext: "secret-value" });

  assert.deepEqual(SSC_ALPHA_ENV_TARGETS, ["production"]);
  assert.deepEqual(payload.target, ["production"]);
  assert.equal(payload.type, "sensitive");
});

test("multiple customer secrets use production-only private provider payloads", () => {
  const payloads = ["DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "META_ACCESS_TOKEN"].map((envKey) =>
    vercelProjectEnvPayload({ envKey, plaintext: "secret-value" }),
  );

  for (const payload of payloads) {
    assert.deepEqual(payload.target, ["production"]);
    assert.equal(payload.type, "sensitive");
  }
});

test("legacy preview plus production target is reconciled by production-only upsert payload", () => {
  const existingProviderEnv = { id: "env_1", key: "DATABASE_URL", target: ["preview", "production"] };
  const payload = vercelProjectEnvPayload({ envKey: existingProviderEnv.key, plaintext: "rotated-secret" });
  const providerResponse = assertVercelEnvUpsertSucceeded({
    created: { id: existingProviderEnv.id, key: existingProviderEnv.key, target: payload.target },
    failed: [],
  }, existingProviderEnv.key);

  assert.deepEqual(providerEnvTargets(providerResponse), ["production"]);
  assert.equal(providerEnvId(providerResponse), existingProviderEnv.id);
});

test("unrelated provider env vars are outside SSC binding reconciliation", () => {
  const applyRuntimeEnv = readControlPlaneFile("trigger/apply-runtime-env.ts");

  assert.match(applyRuntimeEnv, /FROM app_secret_bindings b/);
  assert.match(applyRuntimeEnv, /WHERE b\.app_id = \$1/);
  assert.match(applyRuntimeEnv, /AND b\.target_environment = 'production'/);
  assert.doesNotMatch(applyRuntimeEnv, /DELETE FROM .*env/i);
  assert.doesNotMatch(applyRuntimeEnv, /list.*env/i);
});

test("public NEXT_PUBLIC keys remain classified as public names but use production env target", () => {
  const payload = vercelProjectEnvPayload({ envKey: "NEXT_PUBLIC_SUPABASE_URL", plaintext: "public-config" });

  assert.equal(isPublicEnvironmentKey(payload.key), true);
  assert.deepEqual(payload.target, ["production"]);
});

test("private secrets never become public by name transformation", () => {
  const payload = vercelProjectEnvPayload({ envKey: "SUPABASE_SERVICE_ROLE_KEY", plaintext: "secret-value" });

  assert.equal(payload.key, "SUPABASE_SERVICE_ROLE_KEY");
  assert.equal(isPublicEnvironmentKey(payload.key), false);
  assert.equal(payload.type, "sensitive");
});

test("runtime and provider identity are verified before decryption and injection", () => {
  const applyRuntimeEnv = readControlPlaneFile("trigger/apply-runtime-env.ts");
  const decryptCall = "const plaintext = await decryptAppSecret";

  assert.ok(
    applyRuntimeEnv.indexOf("assertRuntimeMatchesDeployment") < applyRuntimeEnv.indexOf(decryptCall),
    "runtime identity must be checked before decrypting secrets",
  );
  assert.ok(
    applyRuntimeEnv.indexOf("assertRemoteProjectMatchesSscApp") < applyRuntimeEnv.indexOf(decryptCall),
    "remote provider identity must be checked before decrypting secrets",
  );
  assert.ok(
    applyRuntimeEnv.indexOf("enforceGitAutoDeployments") < applyRuntimeEnv.indexOf(decryptCall),
    "Git auto-deploy containment must be verified before decrypting secrets",
  );
});

test("provider update failure cannot be reported as applied", () => {
  assert.throws(
    () => assertVercelEnvUpsertSucceeded({
      failed: [{ error: { envVarKey: "DATABASE_URL", code: "env_update_failed", value: "must-not-be-reported" } }],
    }, "DATABASE_URL"),
    /Vercel environment upsert failed for DATABASE_URL: env_update_failed/,
  );
});

test("production API build fixture keeps required production env configuration", () => {
  const executeBuild = readControlPlaneFile("trigger/execute-build.ts");
  const applyRuntimeEnv = readControlPlaneFile("trigger/apply-runtime-env.ts");

  assert.match(executeBuild, /target:"production"/);
  assert.match(applyRuntimeEnv, /SSC_ALPHA_ENV_TARGETS/);
  assert.match(applyRuntimeEnv, /providerTargets = \[\.\.\.SSC_ALPHA_ENV_TARGETS\]/);
});
