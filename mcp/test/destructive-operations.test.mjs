import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// This suite proves item 9's second half by discovery, not by trusting a
// hand-maintained list of "the destructive things" that could silently go
// stale as the codebase grows. Every assertion here is derived from
// scanning the actual repository at test time.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const schemasDir = path.join(here, "..", "schemas");

function readTool(file) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
}

function discoverTriggerTaskIds() {
  const dir = path.join(repoRoot, "control-plane", "trigger");
  const ids = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of content.matchAll(/id:\s*"(ssc-control-plane-[a-z-]+)"/g)) {
      ids.push(match[1]);
    }
  }
  return ids;
}

test("the only destructive-sounding trigger task anywhere in control-plane is delete-app — no new one has appeared unnoticed", () => {
  const ids = discoverTriggerTaskIds();
  const destructive = ids.filter((id) => /delete|destroy|purge|wipe/i.test(id));
  assert.deepEqual(destructive, ["ssc-control-plane-delete-app"]);
});

test("no customer-interface server module exports a delete/destroy function — app deletion is not reachable from the web API surface at all, let alone MCP", () => {
  const serverDir = path.join(repoRoot, "customer-interface", "src", "server");
  const offenders = [];
  for (const file of fs.readdirSync(serverDir)) {
    if (!file.endsWith(".mjs")) continue;
    const content = fs.readFileSync(path.join(serverDir, file), "utf8");
    for (const match of content.matchAll(/export\s+async\s+function\s+(\w*(?:[Dd]elete|[Dd]estroy)\w*)/g)) {
      offenders.push(`${file}#${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no API route anywhere in customer-interface implements a DELETE HTTP method handler", () => {
  const apiDir = path.join(repoRoot, "customer-interface", "app", "api");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.js") {
        const content = fs.readFileSync(full, "utf8");
        if (/export\s+async\s+function\s+DELETE\b/.test(content)) offenders.push(full);
      }
    }
  };
  walk(apiDir);
  assert.deepEqual(offenders, []);
});

test("mcp-auth.mjs never references delete-app or any destructive-sounding operation", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "customer-interface", "src", "server", "mcp-auth.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /delete-app|deleteApp|delete_app|destroy|purge|wipe/i);
});

test("no MCP tool schema's backedBy.existingFunctions references a destructive operation", () => {
  for (const file of fs.readdirSync(schemasDir)) {
    const tool = readTool(file);
    const refs = tool.backedBy?.existingFunctions ?? [];
    for (const ref of refs) {
      assert.doesNotMatch(ref, /delete|destroy|purge|wipe|billing/i, `${file}'s backedBy references "${ref}", which looks destructive`);
    }
  }
});

test("no MCP tool name or description promises a destructive capability", () => {
  for (const file of fs.readdirSync(schemasDir)) {
    const tool = readTool(file);
    assert.doesNotMatch(tool.name, /delete|destroy|purge|wipe|billing/i);
    assert.doesNotMatch(tool.description, /\bdelete\b|\bdestroy\b|\bpurge\b|\bwipe\b|\bbilling\b/i);
  }
});
