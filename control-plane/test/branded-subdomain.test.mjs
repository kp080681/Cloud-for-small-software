import test from "node:test";
import assert from "node:assert/strict";
import { RESERVED_BRANDED_SUBDOMAINS, brandedSubdomainForSlug } from "../src/provider-project-identity.mjs";

test("ordinary app names keep their own subdomain", () => {
  assert.equal(brandedSubdomainForSlug("three-simple-recipes"), "three-simple-recipes");
  assert.equal(brandedSubdomainForSlug("Vantage"), "vantage");
});

test("platform names can never be taken by a customer app", () => {
  for (const name of ["app", "APP", "www", "api", "mcp", "docs", "status", "admin"]) {
    const sub = brandedSubdomainForSlug(name);
    assert.equal(RESERVED_BRANDED_SUBDOMAINS.has(sub), false, name);
    assert.equal(sub, `${name.toLowerCase()}-site`);
  }
});

test("an empty or symbol-only name doesn't fall through to app.utplava.dev", () => {
  assert.equal(brandedSubdomainForSlug(""), "app-site");
  assert.equal(brandedSubdomainForSlug("!!!"), "app-site");
});

test("subdomains stay inside the 63-character DNS label limit", () => {
  assert.ok(brandedSubdomainForSlug("x".repeat(200)).length <= 63);
});
