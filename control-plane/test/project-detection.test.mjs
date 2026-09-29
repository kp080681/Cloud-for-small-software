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

test("classifies a package with only a build script (no start, no next) as a supported static site, not a Node.js server", () => {
  // Regression guard for a real, confirmed-live bug: a real external
  // repository ("math-game") had exactly this shape — a build script that
  // was just `echo 'static site, nothing to build'`, no start script at
  // all — and was previously classified as "nodejs", which Vercel's own
  // API correctly rejected at deploy time with "No entrypoint found",
  // since there was no server process to actually run.
  const result = detectProject({
    packageJson: {
      name: "quick-math-game",
      scripts: { build: "echo 'static site, nothing to build'" },
    },
    rootFiles: ["package.json", "index.html"],
  });
  assert.equal(result.supported, true);
  assert.equal(result.framework, "static");
  assert.equal(result.runtime, "static");
});

test("a real start script still correctly means a Node.js server app, build script or not", () => {
  const result = detectProject({
    packageJson: {
      scripts: { build: "tsc", start: "node dist/server.js" },
    },
    rootFiles: ["package.json"],
  });
  assert.equal(result.supported, true);
  assert.equal(result.framework, "nodejs");
  assert.equal(result.runtime, "nodejs");
});

test("a start script alone, with no build script at all, is still correctly a Node.js server app", () => {
  const result = detectProject({
    packageJson: { scripts: { start: "node index.js" } },
    rootFiles: ["package.json"],
  });
  assert.equal(result.supported, true);
  assert.equal(result.framework, "nodejs");
  assert.equal(result.runtime, "nodejs");
});
