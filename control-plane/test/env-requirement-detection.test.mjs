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

test("detects destructured process.env references, the dominant AI-generated pattern", () => {
  const result = detectEnvReferencesInSource({
    path: "app/api/route.ts",
    content: `
      const { OPENAI_API_KEY, DATABASE_URL } = process.env;
    `,
  });

  assert.equal(result.skipped, false);
  assert.deepEqual(result.detections.map((item) => item.envKey), [
    "DATABASE_URL",
    "OPENAI_API_KEY",
  ]);
});

test("destructured aliasing reads the source property, not the local alias", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: `const { STRIPE_SECRET_KEY: stripeKey } = process.env;`,
  });

  assert.deepEqual(result.detections.map((item) => item.envKey), ["STRIPE_SECRET_KEY"]);
});

test("destructured default values do not corrupt sibling key detection", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: `const { MAX_RETRIES = computeDefault(1, 2), API_KEY } = process.env;`,
  });

  assert.deepEqual(result.detections.map((item) => item.envKey), ["API_KEY", "MAX_RETRIES"]);
});

test("rest element in destructuring is not treated as a specific env key", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: `const { API_KEY, ...rest } = process.env;`,
  });

  assert.deepEqual(result.detections.map((item) => item.envKey), ["API_KEY"]);
});

test("NEXT_PUBLIC_ keys read via destructuring are still classified public", () => {
  const result = detectEnvReferencesInSource({
    path: "app/page.tsx",
    content: `const { NEXT_PUBLIC_SITE_URL } = process.env;`,
  });

  assert.equal(result.detections[0].public, true);
});

test("detects bracket access with a static template-literal key", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: "const key = process.env[`RESEND_API_KEY`];",
  });

  assert.deepEqual(result.detections.map((item) => item.envKey), ["RESEND_API_KEY"]);
});

test("interpolated template-literal bracket access is not falsely detected", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: "const key = process.env[`PREFIX_${suffix}`];",
  });

  assert.deepEqual(result.detections, []);
});

test("platform-injected variables are excluded from detection entirely, even when referenced", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: `
      if (process.env.NODE_ENV === "production") { /* ... */ }
      const port = process.env.PORT || 3000;
      const region = process.env.VERCEL_REGION;
    `,
  });

  assert.deepEqual(result.detections, []);
});

test("a real customer secret alongside excluded platform variables is still detected", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: `
      const isProd = process.env.NODE_ENV === "production";
      const key = process.env.OPENAI_API_KEY;
    `,
  });

  assert.deepEqual(result.detections.map((item) => item.envKey), ["OPENAI_API_KEY"]);
});

test("detects optional-chaining process.env access, a common defensive-coding style", () => {
  const result = detectEnvReferencesInSource({
    path: "app/lib/config.ts",
    content: `
      const a = process?.env?.RESEND_API_KEY;
      const b = process?.env.STRIPE_SECRET_KEY;
      const { SUPABASE_URL } = process?.env;
    `,
  });

  assert.deepEqual(result.detections.map((item) => item.envKey), [
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "SUPABASE_URL",
  ]);
});

test("rejects oversized source files deterministically", () => {
  assert.throws(
    () => detectEnvReferencesInSource({
      path: "app/large.ts",
      content: `${"x".repeat(512 * 1024 + 1)}process.env.SHOULD_NOT_SCAN`,
    }),
    (error) => error?.code === "SOURCE_FILE_TOO_LARGE",
  );
});
