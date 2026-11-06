import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLISH_LIMITS,
  checkPublishUpload,
  findLeakedSecrets,
  findPhishingSignals,
  normalizeUploadPath,
  publishFiles,
  safePublishError,
  validateAppName,
  validatePublishFiles,
} from "../src/server/direct-publish.mjs";

const page = (body, title = "My cafe") => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const html = (content) => ({ path: "index.html", content });
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};
const asText = (path, text) => ({ path, content: Buffer.from(text), text: true });

test("paths that escape the app folder or carry tooling are refused", () => {
  assert.equal(normalizeUploadPath("./css/site.css"), "css/site.css");
  assert.equal(normalizeUploadPath("assets\\logo.png"), "assets/logo.png");
  for (const bad of ["../secret.html", "/etc/passwd", "a//b.html", "C:/x.html", "a/../../b.html", "x\u0000.html"]) {
    assert.equal(codeOf(() => normalizeUploadPath(bad)), "PUBLISH_PATH_INVALID", bad);
  }
  assert.equal(codeOf(() => normalizeUploadPath(".env")), "PUBLISH_ENV_FILE");
  assert.equal(codeOf(() => normalizeUploadPath("app/.env.local")), "PUBLISH_ENV_FILE");
  assert.equal(codeOf(() => normalizeUploadPath(".git/config")), "PUBLISH_HIDDEN_FILE");
  assert.equal(codeOf(() => normalizeUploadPath("node_modules/x/index.js")), "PUBLISH_NODE_MODULES");
  assert.equal(codeOf(() => normalizeUploadPath("a/b/c/d/e/f/g.html")), "PUBLISH_PATH_INVALID");
});

test("uploads need a home page or package.json, web file types, and stay within limits", () => {
  assert.equal(codeOf(() => validatePublishFiles([])), "PUBLISH_NO_FILES");
  assert.equal(codeOf(() => validatePublishFiles([{ path: "about.html", content: "<p>x</p>" }])), "PUBLISH_NO_ENTRY");
  assert.equal(codeOf(() => validatePublishFiles([html("x"), { path: "run.sh", content: "rm -rf /" }])), "PUBLISH_FILE_TYPE");
  assert.equal(codeOf(() => validatePublishFiles([html("x"), { path: "server.php", content: "<?php" }])), "PUBLISH_FILE_TYPE");
  assert.equal(codeOf(() => validatePublishFiles([html("a"), { path: "INDEX.html", content: "b" }])), "PUBLISH_DUPLICATE_FILE");
  const many = Array.from({ length: PUBLISH_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `p${i}.html`, content: "x" }));
  assert.equal(codeOf(() => validatePublishFiles(many)), "PUBLISH_TOO_MANY_FILES");
  const big = "x".repeat(PUBLISH_LIMITS.maxTotalBytes + 1);
  assert.equal(codeOf(() => validatePublishFiles([html(big)])), "PUBLISH_TOO_LARGE");
  assert.equal(codeOf(() => validatePublishFiles([html("x"), { path: "logo.png", content: "%%%", encoding: "base64" }])), "PUBLISH_FILE_INVALID");
});

test("a single wrapping folder is removed and binary files are decoded", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const { files, totalBytes } = validatePublishFiles([
    { path: "my-site/index.html", content: "<p>hi</p>" },
    { path: "my-site/img/logo.png", content: png.toString("base64"), encoding: "base64" },
  ]);
  assert.deepEqual(files.map((f) => f.path), ["img/logo.png", "index.html"]);
  assert.deepEqual(files[0].content, png);
  assert.equal(files[0].text, false);
  assert.equal(totalBytes, png.length + 9);
});

test("leaked secret keys are found by kind, public keys are not", () => {
  const jwt = (role) =>
    ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ role, iss: "supabase" })).toString("base64url"), "c2lnbmF0dXJlLXZhbHVlLWhlcmU"].join(".");
  const cases = [
    ["const k = 'sk_live_51HxYzAbCdEfGhIjKlMnOp'", "a Stripe or Clerk secret key"],
    ["key: 'sk-ant-api03-abcdefghijklmnopqrstuvwx'", "an Anthropic API key"],
    ["OPENAI='sk-proj-abcdefghijklmnopqrstuvwxyz012345'", "an OpenAI API key"],
    ["AKIAABCDEFGHIJKLMNOP", "an AWS access key"],
    ["-----BEGIN PRIVATE KEY-----", "a private key"],
    ["re_123abc45_AbCdEfGhIjKlMnOp", "a Resend API key"],
    [`createClient(url, '${jwt("service_role")}')`, "a Supabase service_role key"],
  ];
  for (const [text, kind] of cases) {
    assert.deepEqual(findLeakedSecrets([asText("app.js", text)]), [{ path: "app.js", kind }], text);
  }
  const safe = [
    "pk_live_51HxYzAbCdEfGhIjKlMnOp",
    `createClient(url, '${jwt("anon")}')`,
    "class=\"sk-loading sk-spinner\"",
    "rzp_live_AbCdEfGhIjKlMn",
  ];
  for (const text of safe) assert.deepEqual(findLeakedSecrets([asText("app.js", text)]), [], text);
  // Binary files are never scanned as text.
  assert.deepEqual(findLeakedSecrets([{ path: "a.png", content: Buffer.from("sk_live_51HxYzAbCdEfGhIjKlMnOp"), text: false }]), []);
});

test("obvious phishing is held back; ordinary sign-in pages and social links are not", () => {
  const signal = (body, title) => findPhishingSignals([asText("index.html", page(body, title))]).map((s) => s.reason);
  assert.equal(signal('<h1>Sign in to your PayPal account</h1><input type="password">').length, 1);
  assert.equal(signal('<input type="password">', "HDFC Bank NetBanking").length, 1);
  assert.equal(signal("<p>Enter your 12-word recovery phrase</p><textarea></textarea>").length, 1);
  assert.equal(signal("<label>CVV</label><input name=c>").length, 1);
  assert.deepEqual(signal('<h1>Log in</h1><input type="password"><a href="https://instagram.com/cafe">Instagram</a>'), []);
  assert.deepEqual(signal('<button>Sign in with Google</button><input type="password">'), []);
  assert.deepEqual(signal("<p>We accept PayPal and Google Pay</p>"), []);
});

test("checkPublishUpload explains the problem without echoing the key", () => {
  const error = (() => {
    try {
      checkPublishUpload([html(page("<script>const k='sk_live_51HxYzAbCdEfGhIjKlMnOp'</script>"))]);
    } catch (e) {
      return e;
    }
  })();
  assert.equal(error.code, "PUBLISH_SECRET_FOUND");
  assert.match(error.message, /index\.html contains a Stripe or Clerk secret key/);
  assert.doesNotMatch(error.message, /sk_live_/);
  assert.equal(codeOf(() => checkPublishUpload([html(page('<h1>Verify your Netflix account</h1><input type="password">'))])), "PUBLISH_REVIEW_REQUIRED");
  assert.equal(checkPublishUpload([html(page("<h1>Fresh bread daily</h1>"))]).files.length, 1);
});

test("app names are short and plain", () => {
  assert.equal(validateAppName("  Bakery   site "), "Bakery site");
  for (const bad of ["", "x", "a".repeat(41), "<script>", "../x", "-dash"]) {
    assert.equal(codeOf(() => validateAppName(bad)), "PUBLISH_NAME_INVALID", bad);
  }
});

// ---- publishFiles with a scripted database and GitHub ----

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const ENV = { UTPLAVA_PUBLISH_GITHUB_ORG: "utplava-apps", UTPLAVA_PUBLISH_GITHUB_TOKEN: "test-token" };

function fakeDb({ member = true, nameTaken = false, managedApp = null, globalCount = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM customer_workspace_memberships cwm")) return { rows: member ? [{ id: WORKSPACE, name: "W" }] : [] };
      if (sql.includes("SELECT 1 FROM apps")) return { rowCount: nameTaken ? 1 : 0, rows: [] };
      if (sql.includes("FROM workspaces WHERE id=$1 FOR UPDATE")) return { rowCount: 1, rows: [{ id: WORKSPACE }] };
      if (sql.includes("workspace_resource_policies")) return { rowCount: 1, rows: [{ max_active_apps: 3 }] };
      if (sql.includes("count(*)::int AS count") && sql.includes("FROM apps")) return { rows: [{ count: 0 }] };
      if (sql.includes("workspace_rate_limit_counters")) return { rows: [{ count: 1 }] };
      if (sql.includes("FROM direct_publishes WHERE")) return { rows: [{ count: globalCount }] };
      if (sql.includes("JOIN github_repositories r ON r.id = a.repository_id")) return { rows: managedApp ? [managedApp] : [] };
      if (sql.includes("INSERT INTO github_repositories")) return { rows: [{ id: "repo-row-1" }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakeOctokit() {
  const log = [];
  return {
    log,
    repos: {
      async createInOrg(args) {
        log.push(["createInOrg", args]);
        return { data: { id: 987, name: args.name, full_name: `${args.org}/${args.name}`, default_branch: "main", owner: { login: args.org } } };
      },
    },
    git: {
      async getRef(args) { log.push(["getRef", args]); return { data: { object: { sha: "a".repeat(40) } } }; },
      async createBlob(args) { log.push(["createBlob", args]); return { data: { sha: `blob${log.length}` } }; },
      async createTree(args) { log.push(["createTree", args]); return { data: { sha: "tree1" } }; },
      async createCommit(args) { log.push(["createCommit", args]); return { data: { sha: "c".repeat(40) } }; },
      async updateRef(args) { log.push(["updateRef", args]); return { data: {} }; },
    },
  };
}

const installationFinder = async () => ({ id: "gi-row-1", org: "utplava-apps" });

test("a new upload creates a private repository, commits the files and records the publish", async () => {
  const db = fakeDb();
  const octokit = fakeOctokit();
  const result = await publishFiles(db, {
    customerId: CUSTOMER,
    workspaceId: WORKSPACE,
    name: "Bakery site",
    files: [html(page("<h1>Bread</h1>"))],
    env: ENV,
    octokitFactory: () => octokit,
    installationFinder,
  });
  assert.equal(result.repositoryId, "repo-row-1");
  assert.equal(result.appName, "Bakery site");
  const created = octokit.log.find(([op]) => op === "createInOrg")[1];
  assert.equal(created.private, true);
  assert.match(created.name, /^bakery-site-[0-9a-f]{8}$/);
  const tree = octokit.log.find(([op]) => op === "createTree")[1];
  assert.equal(tree.base_tree, undefined, "an upload replaces the app's files");
  assert.deepEqual(tree.tree.map((t) => t.path), ["index.html"]);
  assert.equal(octokit.log.find(([op]) => op === "updateRef")[1].force, false);
  const insertRepo = db.calls.find((c) => c.sql.includes("INSERT INTO github_repositories"));
  assert.match(insertRepo.sql, /managed_by_utplava, display_name/);
  assert.equal(insertRepo.params[0], WORKSPACE);
  const audit = db.calls.find((c) => c.sql.includes("INSERT INTO direct_publishes"));
  assert.equal(audit.params[3], "dashboard");
  assert.equal(audit.params[6].length, 64);
  assert.ok(!JSON.stringify(audit.params).includes("Bread"), "file contents are never stored");
});

test("nothing is created when a check fails", async () => {
  const cases = [
    [{ member: false }, { name: "Bakery", files: [html("<p>x</p>")] }, "WORKSPACE_NOT_FOUND"],
    [{}, { name: "Bakery", files: [html("sk_live_51HxYzAbCdEfGhIjKlMnOp")] }, "PUBLISH_SECRET_FOUND"],
    [{ nameTaken: true }, { name: "Bakery", files: [html("<p>x</p>")] }, "PUBLISH_NAME_TAKEN"],
    [{ globalCount: PUBLISH_LIMITS.globalPerHour }, { name: "Bakery", files: [html("<p>x</p>")] }, "PUBLISH_BUSY"],
    [{}, { appId: "33333333-3333-3333-3333-333333333333", files: [html("<p>x</p>")] }, "PUBLISH_APP_NOT_FOUND"],
  ];
  for (const [dbOptions, input, code] of cases) {
    const octokit = fakeOctokit();
    await assert.rejects(
      publishFiles(fakeDb(dbOptions), { customerId: CUSTOMER, workspaceId: WORKSPACE, env: ENV, octokitFactory: () => octokit, installationFinder, ...input }),
      (error) => error.code === code,
      code,
    );
    assert.equal(octokit.log.length, 0, `${code}: GitHub untouched`);
  }
  await assert.rejects(
    publishFiles(fakeDb(), { customerId: CUSTOMER, workspaceId: WORKSPACE, name: "Bakery", files: [html("<p>x</p>")], env: {} }),
    (error) => error.code === "PUBLISH_NOT_CONFIGURED",
  );
});

test("updating an uploaded app commits on top of its own repository", async () => {
  const db = fakeDb({ managedApp: { app_id: "app-1", name: "Bakery site", repository_id: "repo-9", full_name: "utplava-apps/bakery-site-0a1b2c3d", default_branch: "main" } });
  const octokit = fakeOctokit();
  const result = await publishFiles(db, {
    customerId: CUSTOMER,
    workspaceId: WORKSPACE,
    appId: "33333333-3333-3333-3333-333333333333",
    files: [html("<p>v2</p>")],
    source: "mcp",
    env: ENV,
    octokitFactory: () => octokit,
    installationFinder: async () => assert.fail("no new repository for an update"),
  });
  assert.equal(result.repositoryId, "repo-9");
  assert.ok(!octokit.log.some(([op]) => op === "createInOrg"));
  assert.equal(octokit.log.find(([op]) => op === "getRef")[1].repo, "bakery-site-0a1b2c3d");
  const lookup = db.calls.find((c) => c.sql.includes("JOIN github_repositories r ON r.id = a.repository_id"));
  assert.match(lookup.sql, /r\.managed_by_utplava/);
  assert.match(lookup.sql, /a\.workspace_id = \$2/);
});

test("errors shown to people are plain and never raw", () => {
  assert.equal(safePublishError(new Error("connect ECONNREFUSED 10.0.0.1")).error.code, "PUBLISH_FAILED");
  assert.equal(safePublishError(Object.assign(new Error("x"), { code: "WORKSPACE_RATE_LIMIT_REACHED" })).error.code, "WORKSPACE_RATE_LIMIT_REACHED");
  assert.equal(safePublishError(Object.assign(new Error("Not Found"), { status: 404 })).error.code, "PUBLISH_FAILED");
});
