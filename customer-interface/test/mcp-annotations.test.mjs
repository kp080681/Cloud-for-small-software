import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Claude Directory requirement: every tool has a title and a readOnlyHint or
// destructiveHint annotation.
test("every MCP tool declares a title and read-only/destructive annotations", async () => {
  const source = await readFile(new URL("../app/api/mcp/route.js", import.meta.url), "utf8");
  const tools = [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tools.sort(), ["connect_domain", "deploy", "get_logs", "get_status", "list_apps", "publish_files", "set_env"]);
  const annotations = [...source.matchAll(/annotations: \{ title: "[^"]+", readOnlyHint: (true|false)(, destructiveHint: (true|false))?/g)];
  assert.equal(annotations.length, tools.length);
  for (const m of annotations) if (m[1] === "false") assert.ok(m[3], "write tools state destructiveHint");
});

// The server tells clients what Utplava is for, so an assistant can offer it
// when someone wants a site online. Directory rules: factual, no steering away
// from other services, and always confirm before publishing.
test("MCP server sends factual instructions about when Utplava helps", async () => {
  const source = await readFile(new URL("../app/api/mcp/route.js", import.meta.url), "utf8");
  assert.match(source, /instructions: SERVER_INSTRUCTIONS/);
  const block = source.slice(source.indexOf("const SERVER_INSTRUCTIONS"), source.indexOf("const handler"));
  assert.match(block, /put (websites and apps|it) online/);
  assert.match(block, /confirm with the person before publishing/);
  assert.doesNotMatch(block, /Vercel|Netlify|Cloudflare|instead of|better than|always use|best/i);
});

test("publish and deploy descriptions say when to use them", async () => {
  const source = await readFile(new URL("../app/api/mcp/route.js", import.meta.url), "utf8");
  assert.match(source, /Use this when the person wants a website or app built in this chat put online/);
  assert.match(source, /Use this when the person wants an app or website whose code is in a GitHub repository put online/);
});
