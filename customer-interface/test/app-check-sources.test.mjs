import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSource } from "../src/server/app-check-sources.mjs";

test("referrers become short site names, never full addresses", () => {
  assert.equal(normalizeSource("https://t.co/abc123"), "x.com");
  assert.equal(normalizeSource("https://www.google.co.in/search?q=x"), "google");
  assert.equal(normalizeSource("https://glama.ai/mcp/connectors/x"), "glama");
  assert.equal(normalizeSource("lnkd.in"), "linkedin");
  assert.equal(normalizeSource(""), "direct");
  assert.equal(normalizeSource("https://news.ycombinator.com/item?id=1"), "news.ycombinator.com");
  assert.equal(normalizeSource("<script>"), "other");
  assert.equal(normalizeSource("x".repeat(80) + ".com"), "other");
});
