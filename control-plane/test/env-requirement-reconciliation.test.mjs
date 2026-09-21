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
