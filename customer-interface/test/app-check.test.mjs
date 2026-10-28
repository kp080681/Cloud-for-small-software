import assert from "node:assert/strict";
import test from "node:test";
import {
  CheckError,
  isBlockedAddress,
  looksLikeEnvFile,
  looksLikeGitConfig,
  maskSecret,
  normalizeTarget,
  runAppCheck,
  scanTextForSecrets,
  scoreFindings,
} from "../src/server/app-check.mjs";

const jwt = (payload) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2lnbmF0dXJlc2lnbmF0dXJl`;

test("private, loopback, metadata and IPv6 local addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "76.76.21.21", "2606:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("normalizeTarget adds https and refuses internal or odd targets", () => {
  assert.equal(normalizeTarget("myapp.com").toString(), "https://myapp.com/");
  for (const bad of ["", "localhost", "http://127.0.0.1", "http://169.254.169.254/latest", "ftp://x.com", "https://a.com:8080", "https://u:p@a.com", "http://intranet", "https://box.local", "http://[::1]/"]) {
    assert.throws(() => normalizeTarget(bad), CheckError, bad);
  }
});

test("secret patterns are found and masked, never returned whole", () => {
  const key = `sk-proj-${"A".repeat(40)}`;
  const stripe = `sk_live_${"9".repeat(24)}`;
  const { findings } = scanTextForSecrets(`const a="${key}"; const b='${stripe}'; const g="AIza${"b".repeat(35)}"`, "main.js");
  const ids = findings.map((f) => f.id).sort();
  assert.deepEqual(ids, ["google-api-key", "openai-key", "stripe-secret"]);
  for (const f of findings) {
    assert.ok(!f.evidence.includes(key) && !f.evidence.includes(stripe));
    assert.match(f.evidence, /…/);
  }
  assert.equal(maskSecret(key).length < 12, true);
});

test("Anthropic keys aren't double-reported as OpenAI keys", () => {
  const { findings } = scanTextForSecrets(`x="sk-ant-api03-${"z".repeat(40)}"`, "a.js");
  assert.deepEqual(findings.map((f) => f.id), ["anthropic-key"]);
});

test("Supabase service_role JWT is critical, anon key is not a finding", () => {
  const service = scanTextForSecrets(`k="${jwt({ iss: "supabase", role: "service_role" })}"`, "a.js");
  assert.deepEqual(service.findings.map((f) => f.id), ["supabase-service-role"]);
  const anon = scanTextForSecrets(`k="${jwt({ iss: "supabase", role: "anon" })}"`, "a.js");
  assert.equal(anon.findings.length, 0);
  assert.equal(anon.supabaseAnon, true);
});

test(".env and .git detection ignores single-page-app HTML fallbacks", () => {
  assert.equal(looksLikeEnvFile("DATABASE_URL=postgres://x\nAPI_KEY=abc\n"), true);
  assert.equal(looksLikeEnvFile("<!doctype html><html><body><div id=root></div></body></html>"), false);
  assert.equal(looksLikeEnvFile("Not found"), false);
  assert.equal(looksLikeGitConfig("[core]\n\trepositoryformatversion = 0\n"), true);
  assert.equal(looksLikeGitConfig("<html>[core]</html>"), false);
});

test("score drops with severity and never goes below zero", () => {
  assert.equal(scoreFindings([]), 10);
  assert.equal(scoreFindings([{ severity: "critical" }]), 6);
  assert.equal(scoreFindings([{ severity: "low" }, { severity: "low" }, { severity: "info" }]), 9);
  assert.equal(scoreFindings(Array(5).fill({ severity: "critical" })), 0);
});

function fakeRequester(routes) {
  const calls = [];
  return {
    calls,
    get used() {
      return calls.length;
    },
    async fetch(url) {
      const key = url.toString();
      calls.push(key);
      const route = routes[key];
      if (!route) return { status: 404, headers: {}, body: "<!doctype html><p>Not found", url: key };
      return { status: 200, headers: {}, url: key, ...route };
    },
  };
}

const goodHeaders = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

test("a clean, well-configured site scores 10 with no findings", async () => {
  const requester = fakeRequester({
    "https://clean.example/": { headers: goodHeaders, body: '<!doctype html><script src="/app.js"></script>' },
    "https://clean.example/app.js": { body: "console.log('hi')" },
    "http://clean.example/": { status: 308, headers: { location: "https://clean.example/" }, body: "" },
  });
  const result = await runAppCheck("clean.example", { requester });
  assert.equal(result.score, 10);
  assert.deepEqual(result.findings, []);
  assert.ok(result.passed.includes("No .env or .git files are publicly downloadable"));
});

test("a leaky AI-built app is reported with masked evidence and fix prompts", async () => {
  const service = jwt({ iss: "supabase", role: "service_role" });
  const requester = fakeRequester({
    "https://leaky.example/": { body: '<!doctype html><script src="/assets/index-abc.js"></script><script src="https://cdn.other.com/x.js"></script>' },
    "https://leaky.example/assets/index-abc.js": { body: `createClient("https://p.supabase.co","${service}")` },
    "https://leaky.example/.env": { body: "SUPABASE_KEY=secret\nOPENAI_API_KEY=sk-x\n" },
    "https://leaky.example/.env.local": { body: "<!doctype html><div id=root></div>" },
  });
  const result = await runAppCheck("https://leaky.example", { requester });
  const ids = result.findings.map((f) => f.id);
  assert.ok(ids.includes("supabase-service-role"));
  assert.ok(ids.includes("env-exposed"));
  assert.ok(ids.includes("supabase-rls"));
  assert.equal(ids.filter((id) => id === "env-exposed").length, 1, "HTML fallback for .env.local is not a finding");
  assert.equal(result.findings[0].severity, "critical");
  assert.ok(!JSON.stringify(result).includes(service), "full key never returned");
  assert.ok(!JSON.stringify(result).includes("=secret"), ".env values never returned");
  assert.ok(!requester.calls.some((c) => c.includes("cdn.other.com")), "other sites' scripts aren't fetched");
  assert.equal(result.score, 0);
  for (const f of result.findings) assert.ok(f.explain && f.fix, f.id);
});

test("an unreachable or erroring site gives a plain error", async () => {
  const requester = fakeRequester({ "https://down.example/": { status: 503, body: "" } });
  await assert.rejects(() => runAppCheck("down.example", { requester }), (e) => e.code === "UNREACHABLE");
});

test("a CSP that doesn't mention scripts passes framing but gets a small note", async () => {
  const requester = fakeRequester({
    "https://framed.example/": { headers: { ...goodHeaders, "content-security-policy": "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" }, body: "<!doctype html>" },
    "http://framed.example/": { status: 308, headers: { location: "https://framed.example/" }, body: "" },
  });
  const result = await runAppCheck("framed.example", { requester });
  assert.deepEqual(result.findings.map((f) => f.id), ["header-csp-scripts"]);
  assert.ok(result.passed.includes("Can't be embedded by other sites"));
  assert.equal(result.score, 10);
});

test("a Supabase backend that no longer resolves is reported as down", async () => {
  const requester = fakeRequester({
    "https://gone.example/": { headers: goodHeaders, body: '<!doctype html><script>createClient("https://abcdefghijklmnopqrst.supabase.co","x")</script>' },
    "http://gone.example/": { status: 308, headers: { location: "https://gone.example/" }, body: "" },
  });
  const lookupHost = async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); };
  const result = await runAppCheck("gone.example", { requester, lookupHost });
  const down = result.findings.find((f) => f.id === "supabase-backend-down");
  assert.ok(down);
  assert.equal(down.severity, "high");
  assert.match(down.evidence, /abcdefghijklmnopqrst\.supabase\.co/);
  assert.ok(!result.findings.some((f) => f.id === "supabase-rls"), "no RLS reminder when there's no backend to protect");
});

test("a live Supabase backend passes, and only the app's own project host is contacted", async () => {
  const requester = fakeRequester({
    "https://alive.example/": { headers: goodHeaders, body: '<!doctype html><script>const u="https://abcdefghijklmnopqrst.supabase.co"</script>' },
    "http://alive.example/": { status: 308, headers: { location: "https://alive.example/" }, body: "" },
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/health": { status: 401, body: "{}" },
  });
  const result = await runAppCheck("alive.example", { requester, lookupHost: async () => ({ address: "1.2.3.4" }) });
  assert.ok(result.passed.includes("Your Supabase backend is answering"));
  assert.ok(result.findings.some((f) => f.id === "supabase-rls"));
  assert.equal(requester.calls.filter((c) => c.includes("supabase.co")).length, 1);
});

test("a paused Supabase project (HTTP 540) is reported as paused", async () => {
  const requester = fakeRequester({
    "https://paused.example/": { headers: goodHeaders, body: '<!doctype html><script>"abcdefghijklmnopqrst.supabase.co"</script>' },
    "http://paused.example/": { status: 308, headers: { location: "https://paused.example/" }, body: "" },
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/health": { status: 540, body: "Project paused" },
  });
  const result = await runAppCheck("paused.example", { requester, lookupHost: async () => ({}) });
  assert.match(result.findings.find((f) => f.id === "supabase-backend-down").evidence, /paused/);
});
