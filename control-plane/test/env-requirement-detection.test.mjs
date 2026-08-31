import assert from "node:assert/strict";
import test from "node:test";
import {
  detectEnvReferencesInSource,
  isDetectableSourcePath,
  mergeEnvDetections,
} from "../src/env-requirement-detection.mjs";

test("detects static process.env references without values", () => {
  const result = detectEnvReferencesInSource({
    path: "app/api/route.ts",
    content: `
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const secret = process.env["SUPABASE_SERVICE_ROLE_KEY"];
      const cron = process.env['CRON_SECRET'];
      const dynamic = process.env[computedName];
    `,
  });

  assert.equal(result.skipped, false);
  assert.deepEqual(result.detections.map((item) => item.envKey), [
    "CRON_SECRET",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  assert.equal(result.detections.find((item) => item.envKey === "NEXT_PUBLIC_SUPABASE_URL").public, true);
  assert.equal(result.detections.find((item) => item.envKey === "CRON_SECRET").requiredInference, "reference-observed");
});

test("merges references by env key and preserves multiple source locations", () => {
  const first = detectEnvReferencesInSource({
    path: "app/page.tsx",
    content: "export const value = process.env.RESEND_API_KEY;",
  });
  const second = detectEnvReferencesInSource({
    path: "app/actions.ts",
    content: "const key = process.env['RESEND_API_KEY'];",
  });

  const merged = mergeEnvDetections([first.detections, second.detections]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].envKey, "RESEND_API_KEY");
  assert.equal(merged[0].sources.length, 2);
});

test("limits detection to source files outside generated and dependency directories", () => {
  assert.equal(isDetectableSourcePath("app/page.tsx"), true);
  assert.equal(isDetectableSourcePath("next.config.mjs"), true);
  assert.equal(isDetectableSourcePath("node_modules/pkg/index.js"), false);
  assert.equal(isDetectableSourcePath(".next/server/app/page.js"), false);
  assert.equal(isDetectableSourcePath("README.md"), false);
});

test("skips oversized source files", () => {
  const result = detectEnvReferencesInSource({
    path: "app/large.ts",
    content: `${"x".repeat(512 * 1024 + 1)}process.env.SHOULD_NOT_SCAN`,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "SOURCE_FILE_TOO_LARGE");
});
