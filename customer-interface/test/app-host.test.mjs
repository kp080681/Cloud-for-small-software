import test from "node:test";
import assert from "node:assert/strict";
import { canonicalAppHost, legacyRedirectTarget, mcpIssuerUrl } from "../src/server/app-host.mjs";

const env = { CANONICAL_APP_HOST: "app.utplava.dev" };

test("nothing moves until the canonical host is set", () => {
  assert.equal(legacyRedirectTarget("https://utplava.vercel.app/", {}), null);
  assert.equal(canonicalAppHost({ CANONICAL_APP_HOST: "bad host/evil" }), null);
});

test("the old address moves to app.utplava.dev with path and query intact", () => {
  assert.equal(
    legacyRedirectTarget("https://utplava.vercel.app/api/mcp/authorize?client_id=a&state=b", env),
    "https://app.utplava.dev/api/mcp/authorize?client_id=a&state=b",
  );
  assert.equal(legacyRedirectTarget("https://utplava.vercel.app/apps/1?workspace=w", env), "https://app.utplava.dev/apps/1?workspace=w");
});

test("GitHub webhooks keep landing on the old address", () => {
  assert.equal(legacyRedirectTarget("https://utplava.vercel.app/api/github/webhook", env), null);
});

test("the new address and preview deployments are served as-is", () => {
  assert.equal(legacyRedirectTarget("https://app.utplava.dev/", env), null);
  assert.equal(legacyRedirectTarget("https://utplava-git-branch-kp080681s-projects.vercel.app/", env), null);
});

test("the MCP issuer follows the canonical host unless set explicitly", () => {
  assert.equal(mcpIssuerUrl(env), "https://app.utplava.dev");
  assert.equal(mcpIssuerUrl({ ...env, MCP_ISSUER_URL: "https://x.example" }), "https://x.example");
  assert.equal(mcpIssuerUrl({ VERCEL_PROJECT_PRODUCTION_URL: "utplava.vercel.app" }), "https://utplava.vercel.app");
});
