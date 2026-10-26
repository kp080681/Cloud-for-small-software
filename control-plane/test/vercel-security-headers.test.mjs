import assert from "node:assert/strict";
import test from "node:test";
import { ensureSecurityHeaders, securityHeadersRule, UTPLAVA_CSP } from "../src/vercel-security-headers.mjs";

test("rule never overrides an app's own CSP and doesn't restrict scripts", () => {
  const rule = securityHeadersRule();
  const csp = rule.route.transforms.find((t) => t.target.key === "Content-Security-Policy");
  assert.equal(csp.op, "append");
  assert.doesNotMatch(UTPLAVA_CSP, /script-src|default-src/);
  assert.match(UTPLAVA_CSP, /frame-ancestors 'self'/);
  assert.equal(rule.route.src, "^/(.*)$");
});

test("stages by id without overwriting other rules, then promotes that version", async () => {
  const calls = [];
  const request = async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) });
    return path.endsWith("/versions?teamId=t") ? { version: { id: "icfg_1", isLive: true } } : { version: { id: "icfg_1" } };
  };
  const result = await ensureSecurityHeaders({ projectId: "prj_1", request, teamQuery: () => "?teamId=t" });
  assert.deepEqual(result, { versionId: "icfg_1", live: true });
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, "/v1/projects/prj_1/routes?teamId=t");
  assert.equal(calls[0].body.overwrite, undefined);
  assert.equal(calls[0].body.routes[0].id, "utplava-security-headers");
  assert.deepEqual(calls[1], { path: "/v1/projects/prj_1/routes/versions?teamId=t", method: "POST", body: { id: "icfg_1", action: "promote" } });
});
