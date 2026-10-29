import assert from "node:assert/strict";
import test from "node:test";
import { recognisedClient } from "../src/server/mcp-recognised-clients.mjs";

test("well-known callbacks, loopback and editor schemes are recognised", () => {
  assert.equal(recognisedClient("https://claude.ai/api/mcp/auth_callback").label, "Claude");
  assert.equal(recognisedClient("https://chatgpt.com/connector_platform_oauth_redirect").label, "ChatGPT");
  assert.equal(recognisedClient("http://127.0.0.1:33418/callback").kind, "local");
  assert.equal(recognisedClient("http://localhost:6274/oauth/callback").kind, "local");
  assert.equal(recognisedClient("cursor://anysphere.cursor-mcp/oauth/callback").label, "Cursor");
});

test("look-alikes and unknown hosts are not recognised", () => {
  for (const uri of [
    "https://attacker-alpha.example.com/cb",
    "https://claude.ai.evil.com/cb",
    "https://evilclaude.ai/cb",
    "http://claude.ai/cb",
    "https://127.0.0.1/cb",
    "http://localhost.evil.com/cb",
    "not a url",
  ]) assert.equal(recognisedClient(uri), null, uri);
});
