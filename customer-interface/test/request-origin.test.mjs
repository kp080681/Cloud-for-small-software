import test from "node:test";
import assert from "node:assert/strict";
import { crossSiteWriteRefusal } from "../src/server/request-origin.mjs";

const base = { method: "POST", pathname: "/api/workspaces/w/applications/a/domain", requestHost: "app.utplava.dev" };

test("dashboard's own writes pass", () => {
  assert.equal(crossSiteWriteRefusal({ ...base, secFetchSite: "same-origin", origin: "https://app.utplava.dev" }), null);
  assert.equal(crossSiteWriteRefusal({ ...base, origin: "https://app.utplava.dev" }), null);
});

test("a customer app on another utplava.dev subdomain can't write with the visitor's cookies", () => {
  assert.equal(crossSiteWriteRefusal({ ...base, secFetchSite: "same-site", origin: "https://evil.utplava.dev" }), "sec-fetch-site:same-site");
  assert.equal(crossSiteWriteRefusal({ ...base, origin: "https://evil.utplava.dev" }), "origin-mismatch");
  assert.equal(crossSiteWriteRefusal({ ...base, secFetchSite: "cross-site", origin: "https://attacker.example" }), "sec-fetch-site:cross-site");
  assert.equal(crossSiteWriteRefusal({ ...base, origin: "null" }), "origin-null");
});

test("reads, non-API pages and the intentionally public endpoints are untouched", () => {
  assert.equal(crossSiteWriteRefusal({ ...base, method: "GET", secFetchSite: "cross-site" }), null);
  assert.equal(crossSiteWriteRefusal({ ...base, pathname: "/apps/a", secFetchSite: "cross-site" }), null);
  for (const pathname of ["/api/github/webhook", "/api/mcp", "/api/mcp/token", "/api/mcp/register", "/api/check", "/api/check/help"]) {
    assert.equal(crossSiteWriteRefusal({ ...base, pathname, secFetchSite: "cross-site", origin: "https://utplava.dev" }), null, pathname);
  }
});

test("the consent decision is still protected (it acts on the session cookie)", () => {
  assert.equal(crossSiteWriteRefusal({ ...base, pathname: "/api/mcp/authorize/decision", secFetchSite: "same-site" }), "sec-fetch-site:same-site");
});

test("server-to-server requests without browser headers pass", () => {
  assert.equal(crossSiteWriteRefusal({ ...base }), null);
});
