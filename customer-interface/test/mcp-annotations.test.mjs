import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Claude Directory requirement: every tool has a title and a readOnlyHint or
// destructiveHint annotation.
test("every MCP tool declares a title and read-only/destructive annotations", async () => {
  const source = await readFile(new URL("../app/api/mcp/route.js", import.meta.url), "utf8");
  const tools = [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tools.sort(), ["connect_domain", "deploy", "get_logs", "get_status", "list_apps", "set_env"]);
  const annotations = [...source.matchAll(/annotations: \{ title: "[^"]+", readOnlyHint: (true|false)(, destructiveHint: (true|false))?/g)];
  assert.equal(annotations.length, tools.length);
  for (const m of annotations) if (m[1] === "false") assert.ok(m[3], "write tools state destructiveHint");
});
