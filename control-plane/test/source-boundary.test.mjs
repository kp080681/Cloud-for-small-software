import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_LIMITS,
  assertDetectableSourceFileCount,
  assertSingleSourceFileSize,
  assertTextSource,
  assertTotalSourceBytes,
  assertUniqueRepositoryPaths,
  normalizeRepositoryRelativePath,
  normalizeRootDirectory,
  relativePathUnderRoot,
  vercelRootDirectory,
} from "../src/source-boundary.mjs";

function assertCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("normalizes safe repository-relative root directories", () => {
  assert.equal(normalizeRootDirectory("."), ".");
  assert.equal(normalizeRootDirectory("./"), ".");
  assert.equal(normalizeRootDirectory("apps/web"), "apps/web");
  assert.equal(normalizeRootDirectory("packages/frontend/"), "packages/frontend");
  assert.equal(vercelRootDirectory("."), undefined);
  assert.equal(vercelRootDirectory("apps/web"), "apps/web");
});

test("rejects root directory traversal and absolute paths", () => {
  for (const value of ["../secret", "..\\secret", "/absolute/path", "C:\\repo", "\\\\server\\share", "apps/../../outside", "apps/%2e%2e/outside"]) {
    assertCode(() => normalizeRootDirectory(value), "ROOT_DIRECTORY_INVALID");
  }
});

test("rejects unsafe repository paths", () => {
  for (const value of ["../package.json", "src/..\\secret.js", "/src/app.ts", "C:\\src\\app.ts", "\\\\server\\share\\app.ts", "src/%2e%2e/app.ts", "src/app.js\0.txt"]) {
    assertCode(() => normalizeRepositoryRelativePath(value), "SOURCE_PATH_UNSAFE");
  }
});

test("calculates paths under the configured root without escaping", () => {
  assert.equal(relativePathUnderRoot("apps/web/app/page.tsx", "apps/web"), "app/page.tsx");
  assert.equal(relativePathUnderRoot("apps/api/app/page.tsx", "apps/web"), null);
});

test("rejects excessive path length and duplicate normalized paths", () => {
  assertCode(() => normalizeRepositoryRelativePath(`${"a".repeat(SOURCE_LIMITS.maxRepositoryPathLength + 1)}.ts`), "SOURCE_PATH_TOO_LONG");
  assertCode(() => assertUniqueRepositoryPaths(["app/page.tsx", "app\\page.tsx"]), "SOURCE_PATH_UNSAFE");
});

test("rejects excessive repository and source analysis sizes", () => {
  assertCode(
    () => assertUniqueRepositoryPaths(Array.from({ length: SOURCE_LIMITS.maxRepositoryEntries + 1 }, (_, index) => `file-${index}.ts`)),
    "SOURCE_FILE_LIMIT_EXCEEDED",
  );
  assertCode(() => assertDetectableSourceFileCount(SOURCE_LIMITS.maxDetectableSourceFiles + 1), "SOURCE_FILE_LIMIT_EXCEEDED");
  assertCode(() => assertSingleSourceFileSize(SOURCE_LIMITS.maxSingleSourceFileBytes + 1), "SOURCE_FILE_TOO_LARGE");
  assertCode(() => assertTotalSourceBytes(SOURCE_LIMITS.maxTotalSourceBytes + 1), "SOURCE_TOO_LARGE");
});

test("rejects binary-like source content", () => {
  assertCode(() => assertTextSource("const x = 1;\0"), "SOURCE_UNSUPPORTED_CONTENT");
});
