import assert from "node:assert/strict";
import test from "node:test";
import {
  missingRequiredEnvKeys,
  reconcileExistingRequirement,
  sourceDetectedRequirement,
} from "../src/env-requirement-reconciliation.mjs";

test("source-detected references default to required, since nothing else in the pipeline ever blocks a deployment for missing config", () => {
  const requirement = sourceDetectedRequirement({
    envKey: "TIMEOUT",
    public: false,
  });
  const missing = missingRequiredEnvKeys([{ ...requirement, configured: false }]);

  assert.deepEqual(requirement, {
    envKey: "TIMEOUT",
    source: "source-detection",
    required: true,
    public: false,
  });
  assert.deepEqual(missing, ["TIMEOUT"]);
});

test("existing required env requirements still block when no binding is configured", () => {
  const missing = missingRequiredEnvKeys([
    {
      envKey: "SUPABASE_SERVICE_ROLE_KEY",
      source: "user-confirmed",
      required: true,
      public: false,
      configured: false,
    },
  ]);

  assert.deepEqual(missing, ["SUPABASE_SERVICE_ROLE_KEY"]);
});

test("source reconciliation never downgrades existing required requirements", () => {
  const reconciled = reconcileExistingRequirement(
    {
      envKey: "NEXT_PUBLIC_SUPABASE_URL",
      source: "user-confirmed",
      required: true,
      public: false,
    },
    {
      envKey: "NEXT_PUBLIC_SUPABASE_URL",
      public: true,
    },
  );

  assert.equal(reconciled.required, true);
  assert.equal(reconciled.public, true);
});

test("source reconciliation also never upgrades an existing row a human deliberately marked optional", () => {
  const reconciled = reconcileExistingRequirement(
    {
      envKey: "OPTIONAL_FEATURE_FLAG",
      source: "user-confirmed",
      required: false,
      public: false,
    },
    {
      envKey: "OPTIONAL_FEATURE_FLAG",
      public: false,
    },
  );

  assert.equal(reconciled.required, false);
});

test("DATABASE_URL never blocks an app whose database Utplava manages (the platform writes it at PROVISIONING)", () => {
  const requirements = [
    { envKey: "DATABASE_URL", source: "source-detection", required: true, public: false, configured: false },
    { envKey: "SESSION_SECRET", source: "source-detection", required: true, public: false, configured: false },
  ];

  assert.deepEqual(missingRequiredEnvKeys(requirements, { databaseMode: "SSC_MANAGED" }), ["SESSION_SECRET"]);
});

test("DATABASE_URL still blocks when the app brings its own database or has none", () => {
  const requirements = [
    { envKey: "DATABASE_URL", source: "source-detection", required: true, public: false, configured: false },
  ];

  assert.deepEqual(missingRequiredEnvKeys(requirements, { databaseMode: "EXTERNAL" }), ["DATABASE_URL"]);
  assert.deepEqual(missingRequiredEnvKeys(requirements, { databaseMode: "NONE" }), ["DATABASE_URL"]);
  assert.deepEqual(missingRequiredEnvKeys(requirements), ["DATABASE_URL"]);
});

test("only DATABASE_URL is platform-managed; other keys on a managed-database app still block", () => {
  const requirements = [
    { envKey: "DATABASE_URL_UNPOOLED", source: "source-detection", required: true, public: false, configured: false },
  ];

  assert.deepEqual(missingRequiredEnvKeys(requirements, { databaseMode: "SSC_MANAGED" }), ["DATABASE_URL_UNPOOLED"]);
});

test("control-plane and customer-interface copies of the reconciliation rules stay identical", async () => {
  const { readFile } = await import("node:fs/promises");
  const engine = await readFile(new URL("../src/env-requirement-reconciliation.mjs", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../../customer-interface/src/shared/control-plane/env-requirement-reconciliation.mjs", import.meta.url), "utf8");
  assert.equal(engine, dashboard);
});
