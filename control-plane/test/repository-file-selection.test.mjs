import assert from "node:assert/strict";
import test from "node:test";
import { selectFilesUnderRoot } from "../src/repository-file-selection.mjs";

const sampleTree = [
  { type: "blob", path: "package.json", sha: "a" },
  { type: "blob", path: "index.js", sha: "b" },
  { type: "tree", path: "src", sha: "c" },
  { type: "blob", path: "src/app.js", sha: "d" },
  { type: "blob", path: "README.md", sha: "e" },
];

test("with root directory '.', every blob is included with its path unchanged", () => {
  const result = selectFilesUnderRoot(sampleTree, ".");
  assert.deepEqual(
    result.map((entry) => entry.path).sort(),
    ["README.md", "index.js", "package.json", "src/app.js"],
  );
});

test("tree entries (directories) are never included, only blobs", () => {
  const result = selectFilesUnderRoot(sampleTree, ".");
  assert.ok(!result.some((entry) => entry.sha === "c"), "the directory entry itself must never appear in the file list");
});

test("with a configured subdirectory root, only files under it are selected, with the prefix stripped", () => {
  const tree = [
    { type: "blob", path: "api/package.json", sha: "a" },
    { type: "blob", path: "api/index.js", sha: "b" },
    { type: "blob", path: "web/index.html", sha: "c" },
    { type: "blob", path: "README.md", sha: "d" },
  ];
  const result = selectFilesUnderRoot(tree, "api");
  assert.deepEqual(
    result.map((entry) => entry.path).sort(),
    ["index.js", "package.json"],
  );
});

test("a trailing slash on the configured root directory is handled the same as no trailing slash — regression guard, since this is exactly the kind of thing easy to get subtly wrong", () => {
  const tree = [{ type: "blob", path: "api/index.js", sha: "a" }];
  const withSlash = selectFilesUnderRoot(tree, "api/");
  const withoutSlash = selectFilesUnderRoot(tree, "api");
  assert.deepEqual(withSlash, withoutSlash);
  assert.equal(withSlash[0].path, "index.js");
});

test("a file that exactly matches the root directory name as a prefix, but isn't actually under it, is correctly excluded", () => {
  // e.g. root directory "api" must not accidentally match "api-docs/readme.md"
  const tree = [
    { type: "blob", path: "api/index.js", sha: "a" },
    { type: "blob", path: "api-docs/readme.md", sha: "b" },
  ];
  const result = selectFilesUnderRoot(tree, "api");
  assert.deepEqual(result.map((entry) => entry.path), ["index.js"]);
});

test("an empty tree, or a root directory matching nothing, returns an empty list rather than throwing", () => {
  assert.deepEqual(selectFilesUnderRoot([], "."), []);
  assert.deepEqual(selectFilesUnderRoot(sampleTree, "nonexistent-dir"), []);
});
