import assert from "node:assert/strict";
import test from "node:test";
import {
  TRY_LIMITS,
  checkPublicRepository,
  enforceTryLimits,
  parseRepoInput,
  settingNamesFromEnvExample,
  summarize,
  visitorBucket,
} from "../src/server/try-repo-check.mjs";

test("repository links in every common shape are understood; other sites and junk are not", () => {
  for (const input of [
    "asha/bakery-app",
    "github.com/asha/bakery-app",
    "https://github.com/asha/bakery-app",
    "https://www.github.com/asha/bakery-app.git",
    "https://github.com/asha/bakery-app/tree/main/src",
    "git@github.com:asha/bakery-app.git",
    "  https://github.com/asha/bakery-app?tab=readme  ",
  ]) {
    assert.deepEqual(parseRepoInput(input), { owner: "asha", repo: "bakery-app" }, input);
  }
  for (const input of ["", "asha", "gitlab.com/asha/app", "https://evil.example/asha/app", "../../etc/passwd", "a/..", "-bad/name", "x".repeat(400), null]) {
    assert.equal(parseRepoInput(input), null, String(input));
  }
});

test("only setting names are read from .env.example, never values", () => {
  const names = settingNamesFromEnvExample("# comment\nVITE_SUPABASE_URL=https://x.supabase.co\nexport STRIPE_SECRET_KEY=sk_test_abc\n\nBAD LINE\nVITE_SUPABASE_URL=dup");
  assert.deepEqual(names, ["VITE_SUPABASE_URL", "STRIPE_SECRET_KEY"]);
});

test("a Lovable-style app is described in plain words", () => {
  const result = summarize({
    fullName: "asha/bakery-app",
    rootFiles: ["package.json", "index.html", ".env.example"],
    packageJson: { scripts: { build: "vite build" }, dependencies: { react: "18", "@supabase/supabase-js": "2" }, devDependencies: { vite: "5", "lovable-tagger": "1" } },
    envExample: "VITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.kind, "a React app (Vite)");
  assert.equal(result.lovable, true);
  assert.equal(result.supabase, true);
  assert.equal(result.database, null);
  assert.deepEqual(result.settings.map((s) => s.name), ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]);
  assert.ok(!JSON.stringify(result).includes("supabase.co"));
});

function fakeGithub({ privateRepo = false, missing = false, files = {} } = {}) {
  const calls = [];
  return {
    calls,
    repos: {
      async get({ owner, repo }) {
        calls.push(["get", owner, repo]);
        if (missing) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { full_name: `${owner}/${repo}`, private: privateRepo, default_branch: "main" } };
      },
      async getContent({ path }) {
        calls.push(["getContent", path]);
        if (path === "") return { data: Object.entries(files).map(([name, text]) => ({ type: "file", name, size: text.length })) };
        return { data: { content: Buffer.from(files[path]).toString("base64") } };
      },
    },
  };
}

test("public repositories are checked read-only; private or missing ones are explained", async () => {
  const gh = fakeGithub({ files: { "index.html": "<h1>hi</h1>", "README.md": "x" } });
  const ready = await checkPublicRepository({ owner: "asha", repo: "site" }, { env: {}, octokitFactory: () => gh });
  assert.equal(ready.status, "ready");
  assert.equal(ready.kind, "a plain website (HTML)");
  assert.ok(gh.calls.every(([op]) => op === "get" || op === "getContent"), "only reads");

  const priv = await checkPublicRepository({ owner: "asha", repo: "secret" }, { env: {}, octokitFactory: () => fakeGithub({ privateRepo: true }) });
  assert.deepEqual(priv, { status: "private", fullName: "asha/secret" });
  const missing = await checkPublicRepository({ owner: "asha", repo: "nope" }, { env: {}, octokitFactory: () => fakeGithub({ missing: true }) });
  assert.equal(missing.status, "private");

  const unsupported = await checkPublicRepository({ owner: "asha", repo: "py" }, { env: {}, octokitFactory: () => fakeGithub({ files: { "main.py": "print()" } }) });
  assert.equal(unsupported.status, "unsupported");
});

test("checks are limited per visitor and overall; visitors are stored only as a keyed hash", async () => {
  const hits = new Map();
  const db = {
    async query(sql, params) {
      if (sql.includes("INSERT INTO public_rate_limits")) {
        const n = (hits.get(params[0]) || 0) + 1;
        hits.set(params[0], n);
        return { rows: [{ hits: n }] };
      }
      return { rows: [] };
    },
  };
  const bucket = visitorBucket("203.0.113.9");
  assert.match(bucket, /^try:[0-9a-f]{32}$/);
  assert.ok(!bucket.includes("203.0.113.9"));
  for (let i = 0; i < TRY_LIMITS.perVisitorPerHour; i++) await enforceTryLimits(db, { ip: "203.0.113.9" });
  await assert.rejects(enforceTryLimits(db, { ip: "203.0.113.9" }), { code: "TRY_LIMIT" });
  hits.set("try:all", TRY_LIMITS.overallPerHour);
  await assert.rejects(enforceTryLimits(db, { ip: "198.51.100.1" }), { code: "TRY_BUSY" });
});
