import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const scanRoots = ["src", "trigger"];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(fullPath)));
    } else if (/\.(mjs|ts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test("temporary resume acceptance harness is absent from production control-plane source", async () => {
  const retiredTokens = [
    ["UTPLAVA", "INTERNAL", "RESUME", "TEST"].join("_"),
    ["INTERNAL", "RESUME", "ACCEPTANCE", "INTERRUPTED"].join("_"),
    ["internal", "resume", "acceptance", "hook"].join("-"),
  ];
  const nested = await Promise.all(scanRoots.map((name) => filesUnder(path.join(root, name))));

  for (const file of nested.flat()) {
    const source = await readFile(file, "utf8");
    for (const token of retiredTokens) {
      assert.equal(source.includes(token), false, `${path.relative(root, file)} contains retired resume harness token`);
    }
  }
});
