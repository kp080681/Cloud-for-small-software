import assert from "node:assert/strict";
import test from "node:test";
import {
  missingRequiredEnvKeys,
  reconcileExistingRequirement,
  sourceDetectedRequirement,
} from "../src/env-requirement-reconciliation.mjs";

test("observed-only new source references are recorded without becoming blocking requirements", () => {
  const requirement = sourceDetectedRequirement({
    envKey: "TIMEOUT",
    public: false,
  });
  const missing = missingRequiredEnvKeys([{ ...requirement, configured: false }]);

  assert.deepEqual(requirement, {
    envKey: "TIMEOUT",
    source: "source-detection",
    required: false,
    public: false,
  });
  assert.deepEqual(missing, []);
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
