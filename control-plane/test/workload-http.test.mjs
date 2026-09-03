import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertSafeWorkloadRedirect,
  assertSafeWorkloadUrl,
  assertNoPlatformCredentialHeaders,
  fetchWorkloadUrl,
  healthCheckRequestInit,
  publicAccessRequestInit,
  safeWorkloadRequestHeaders,
} from "../src/workload-http.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("health request to workload URL does not contain Authorization or VERCEL_TOKEN", () => {
  const previous = process.env.VERCEL_TOKEN;
  process.env.VERCEL_TOKEN = "vercel-platform-token";
  try {
    const init = healthCheckRequestInit();
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(Object.hasOwn(init.headers, "Authorization"), false);
    assert.equal(Object.hasOwn(init.headers, "authorization"), false);
    assert.equal(JSON.stringify(init.headers).includes("vercel-platform-token"), false);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previous;
  }
});

test("public-access request to workload URL does not contain Authorization", () => {
  const init = publicAccessRequestInit({ userAgent: "test-browser" });
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal(Object.hasOwn(init.headers, "Authorization"), false);
  assert.equal(Object.hasOwn(init.headers, "authorization"), false);
  assert.equal(init.headers.Accept.includes("text/html"), true);
});

test("workload headers reject platform credential headers and values", () => {
  assert.throws(
    () => safeWorkloadRequestHeaders({ Authorization: "Bearer anything" }),
    /Workload request header is not allowed: Authorization/,
  );

  assert.throws(
    () => assertNoPlatformCredentialHeaders({ "X-Health-Check": "token-value" }, { VERCEL_TOKEN: "token-value" }),
    /Workload request header contains a platform credential: X-Health-Check/,
  );
});

test("redirect-following health checks cannot forward platform credentials", () => {
  const previous = process.env.VERCEL_TOKEN;
  process.env.VERCEL_TOKEN = "redirect-secret";
  try {
    const init = healthCheckRequestInit();
    assert.equal(init.redirect, "manual");
    assert.equal(JSON.stringify(init.headers).includes("redirect-secret"), false);
    assert.equal(Object.keys(init.headers).some((name) => name.toLowerCase() === "authorization"), false);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previous;
  }
});

test("workload URL validation blocks localhost, private networks, metadata hosts, and unexpected schemes", () => {
  for (const url of [
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://metadata.google.internal",
    "http://example.vercel.app",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => assertSafeWorkloadUrl(url), (error) => error?.code === "WORKLOAD_URL_UNSAFE");
  }
});

test("workload URL validation accepts expected Vercel workload hosts", () => {
  assert.equal(assertSafeWorkloadUrl("https://ssc-app.vercel.app").hostname, "ssc-app.vercel.app");
});

test("workload redirect validation blocks unsafe targets", () => {
  assert.throws(
    () => assertSafeWorkloadRedirect("https://127.0.0.1/admin", "https://ssc-app.vercel.app"),
    (error) => error?.code === "WORKLOAD_REDIRECT_UNSAFE",
  );
  assert.throws(
    () => assertSafeWorkloadRedirect("https://169.254.169.254/latest/meta-data", "https://ssc-app.vercel.app"),
    (error) => error?.code === "WORKLOAD_REDIRECT_UNSAFE",
  );
});

test("manual workload fetch follows only safe redirects and omits credentials", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: "https://final.vercel.app/" } });
    }
    return new Response(null, { status: 200 });
  };
  try {
    const { response, finalUrl, redirectCount } = await fetchWorkloadUrl(
      "https://initial.vercel.app/",
      healthCheckRequestInit(),
    );
    assert.equal(response.status, 200);
    assert.equal(finalUrl, "https://final.vercel.app/");
    assert.equal(redirectCount, 1);
    assert.equal(calls.length, 2);
    assert.equal(Object.keys(calls[0].init.headers).some((name) => name.toLowerCase() === "authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual workload fetch blocks private redirect without requesting the target", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  };
  try {
    await assert.rejects(
      () => fetchWorkloadUrl("https://initial.vercel.app/", healthCheckRequestInit()),
      (error) => error?.code === "WORKLOAD_REDIRECT_UNSAFE",
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual workload fetch blocks redirect loops", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://loop.vercel.app/" } });
  try {
    await assert.rejects(
      () => fetchWorkloadUrl("https://loop.vercel.app/", healthCheckRequestInit(), { maxRedirects: 1 }),
      (error) => error?.code === "WORKLOAD_REDIRECT_UNSAFE",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider API requests still use Vercel Authorization where required", () => {
  const providerApiFiles = [
    "trigger/apply-runtime-env.ts",
    "trigger/configure-public-access.ts",
    "trigger/delete-app.ts",
    "trigger/detect-orphan-resources.ts",
    "trigger/execute-build.ts",
    "trigger/ingest-build-logs.ts",
    "trigger/provision-runtime.ts",
    "trigger/reconcile-build.ts",
    "scripts/create-disposable-orphan-fixture.mjs",
  ];

  for (const file of providerApiFiles) {
    const source = readControlPlaneFile(file);
    assert.match(source, /Authorization/);
    assert.match(source, /VERCEL_TOKEN/);
  }
});

test("workload request call sites use safe workload request helpers", () => {
  const healthCheck = readControlPlaneFile("trigger/health-check.ts");
  const publicAccess = readControlPlaneFile("trigger/configure-public-access.ts");

  assert.match(healthCheck, /healthCheckRequestInit/);
  assert.doesNotMatch(healthCheck, /Authorization["']?\s*:\s*process\.env\.VERCEL_TOKEN/);
  assert.match(publicAccess, /publicAccessRequestInit/);
});

test("workload verification continues to avoid storing response bodies", () => {
  const healthCheck = readControlPlaneFile("trigger/health-check.ts");
  const publicAccess = readControlPlaneFile("trigger/configure-public-access.ts");

  assert.match(healthCheck, /response\.body\?\.cancel\(\)/);
  assert.match(healthCheck, /responseBodyStored:false/);
  assert.match(publicAccess, /response\.body\?\.cancel\(\)/);
  assert.match(publicAccess, /responseBodyStored:false/);
});
