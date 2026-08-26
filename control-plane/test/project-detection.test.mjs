import assert from "node:assert/strict";
import test from "node:test";
import { detectProject } from "../src/project-detection.mjs";

test("detects supported Next.js npm application", () => {
  const result = detectProject({
    packageJson: {
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "15.0.0", react: "19.0.0" },
    },
    rootFiles: ["package.json", "package-lock.json", "next.config.js"],
  });

  assert.equal(result.supported, true);
  assert.equal(result.framework, "nextjs");
  assert.equal(result.runtime, "nodejs");
  assert.equal(result.packageManager, "npm");
  assert.equal(result.databaseRequired, false);
});

test("detects PostgreSQL requirement from dependencies", () => {
  const result = detectProject({
    packageJson: {
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "15.0.0", pg: "8.0.0" },
    },
    rootFiles: ["package.json", "pnpm-lock.yaml", ".env.example"],
  });

  assert.equal(result.databaseRequired, true);
  assert.equal(result.packageManager, "pnpm");
  assert.equal(result.envExamplePresent, true);
});

test("rejects repository without package.json", () => {
  const result = detectProject({ packageJson: null, rootFiles: ["README.md"] });
  assert.equal(result.supported, false);
  assert.equal(result.reason, "PACKAGE_JSON_NOT_FOUND");
});

test("rejects unsupported package without node build/start scripts", () => {
  const result = detectProject({
    packageJson: { dependencies: { react: "19.0.0" } },
    rootFiles: ["package.json"],
  });
  assert.equal(result.supported, false);
  assert.equal(result.reason, "UNSUPPORTED_PROJECT");
});
