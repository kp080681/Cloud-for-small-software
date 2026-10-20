import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  parsePushEvent,
  processPushDelivery,
  recordWebhookDelivery,
  verifyGithubSignature,
} from "../src/server/github-push-deploy.mjs";

const SECRET = "test-webhook-secret";
const sign = (body, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

class FakeDb {
  constructor({ targets = [], runningPolls = [] } = {}) {
    this.targets = targets;
    this.runningPolls = [...runningPolls]; // successive answers to "is a deployment running?"
    this.deliveries = new Set();
  }
  async query(text, params = []) {
    if (text.includes("INSERT INTO github_webhook_deliveries")) {
      if (this.deliveries.has(params[0])) return { rowCount: 0, rows: [] };
      this.deliveries.add(params[0]);
      return { rowCount: 1, rows: [{ id: `row-${params[0]}` }] };
    }
    if (text.includes("FROM github_repositories r")) {
      const [repositoryId, installationId] = params;
      return { rows: this.targets.filter((t) => t.github_repository_id === repositoryId && t.installation_id === installationId) };
    }
    if (text.includes("FROM deployments") && text.includes("orchestrator_run_id IS NOT NULL")) {
      const running = this.runningPolls.length ? this.runningPolls.shift() : false;
      return { rowCount: running ? 1 : 0, rows: running ? [{ id: "running" }] : [] };
    }
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

const target = (overrides = {}) => ({
  app_id: "app-1",
  workspace_id: "ws-1",
  auto_deploy_on_push: true,
  repository_id: "repo-row-1",
  default_branch: "main",
  has_live: true,
  owner_customer_id: "owner-1",
  github_repository_id: 42,
  installation_id: 7,
  ...overrides,
});

const push = (overrides = {}) => ({
  ref: "refs/heads/main",
  after: "a".repeat(40),
  deleted: false,
  installationId: 7,
  repositoryId: 42,
  ...overrides,
});

function recorder({ supported = true, startResult = { start: { started: true } }, startError = null } = {}) {
  const calls = { analyze: [], start: [] };
  return {
    calls,
    deps: {
      analyze: async (_db, args) => {
        calls.analyze.push(args);
        return { supported, appId: "app-1", deploymentId: "dep-new" };
      },
      start: async (_db, args) => {
        calls.start.push(args);
        if (startError) throw startError;
        return startResult;
      },
      maxWaitMs: 50,
      pollMs: 1,
      sleep: async () => {},
    },
  };
}

test("signature: accepts GitHub's exact signature and rejects anything else", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyGithubSignature(body, sign(body), SECRET), true);
  assert.equal(verifyGithubSignature(body + " ", sign(body), SECRET), false, "tampered body");
  assert.equal(verifyGithubSignature(body, sign(body, "wrong-secret"), SECRET), false, "wrong secret");
  assert.equal(verifyGithubSignature(body, undefined, SECRET), false, "missing header");
  assert.equal(verifyGithubSignature(body, "sha1=abc", SECRET), false, "old sha1 header");
  assert.equal(verifyGithubSignature(body, sign(body), ""), false, "no secret configured");
});

test("duplicate GitHub deliveries are recorded once and flagged as duplicates", async () => {
  const db = new FakeDb();
  const first = await recordWebhookDelivery(db, { deliveryId: "d-1", eventType: "push", push: push() });
  const again = await recordWebhookDelivery(db, { deliveryId: "d-1", eventType: "push", push: push() });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
});

test("parsePushEvent reads ids from the verified payload", () => {
  const parsed = parsePushEvent({ ref: "refs/heads/main", after: "b".repeat(40), installation: { id: 7 }, repository: { id: 42, name: "ignored" } });
  assert.deepEqual(parsed, { ref: "refs/heads/main", after: "b".repeat(40), deleted: false, installationId: 7, repositoryId: 42 });
});

test("a push to the main branch of a live app analyses as a push and starts a deploy", async () => {
  const db = new FakeDb({ targets: [target()] });
  const { calls, deps } = recorder();
  const result = await processPushDelivery(db, push(), deps);
  assert.equal(result.status, "deploying");
  assert.equal(calls.analyze.length, 1);
  assert.deepEqual(calls.analyze[0], { customerId: "owner-1", workspaceId: "ws-1", repositoryId: "repo-row-1", deploymentReason: "push" });
  assert.deepEqual(calls.start[0], { customerId: "owner-1", workspaceId: "ws-1", appId: "app-1", deploymentId: "dep-new" });
});

test("pushes to other branches, tags and deleted branches never deploy", async () => {
  const db = new FakeDb({ targets: [target()] });
  const { calls, deps } = recorder();
  assert.match((await processPushDelivery(db, push({ ref: "refs/heads/feature-x" }), deps)).detail, /not_main_branch/);
  assert.equal((await processPushDelivery(db, push({ ref: "refs/tags/v1.0" }), deps)).detail, "not_a_branch_push");
  assert.equal((await processPushDelivery(db, push({ deleted: true, after: "0".repeat(40) }), deps)).detail, "branch_deleted");
  assert.equal(calls.analyze.length, 0);
  assert.equal(calls.start.length, 0);
});

test("respects the per-app switch, and the first deploy stays manual", async () => {
  const { calls, deps } = recorder();
  const off = await processPushDelivery(new FakeDb({ targets: [target({ auto_deploy_on_push: false })] }), push(), deps);
  const notLive = await processPushDelivery(new FakeDb({ targets: [target({ has_live: false })] }), push(), deps);
  assert.match(off.detail, /auto_deploy_off/);
  assert.match(notLive.detail, /not_yet_live/);
  assert.equal(calls.analyze.length, 0);
});

test("a repository Utplava doesn't know, or the same repo id under another installation, is ignored", async () => {
  const { calls, deps } = recorder();
  const unknown = await processPushDelivery(new FakeDb({ targets: [target()] }), push({ repositoryId: 999 }), deps);
  const otherInstall = await processPushDelivery(new FakeDb({ targets: [target()] }), push({ installationId: 8 }), deps);
  assert.equal(unknown.detail, "no_app_for_repository");
  assert.equal(otherInstall.detail, "no_app_for_repository");
  assert.equal(calls.analyze.length, 0);
});

test("waits for a deployment already running before starting the next one", async () => {
  const db = new FakeDb({ targets: [target()], runningPolls: [true, true, false] });
  const { calls, deps } = recorder();
  const result = await processPushDelivery(db, push(), deps);
  assert.equal(result.status, "deploying");
  assert.equal(db.runningPolls.length, 0, "polled until the running deployment finished");
  assert.equal(calls.start.length, 1);
});

test("gives up (without deploying) if the running deployment never finishes in time", async () => {
  const db = new FakeDb({ targets: [target()], runningPolls: Array(10_000).fill(true) });
  const { calls, deps } = recorder();
  deps.maxWaitMs = 5;
  deps.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const result = await processPushDelivery(db, push(), deps);
  assert.match(result.detail, /queued_timeout/);
  assert.equal(calls.analyze.length, 0);
});

test("a commit that's already deploying or live is not started twice", async () => {
  const db = new FakeDb({ targets: [target()] });
  const { deps } = recorder({ startResult: { start: { started: false, alreadyStarted: true } } });
  const result = await processPushDelivery(db, push(), deps);
  assert.match(result.detail, /already_deployed/);
});

test("existing guards surface as clear outcomes instead of crashing", async () => {
  const paused = Object.assign(new Error("paused"), { name: "AppPausedError", code: "APP_PAUSED" });
  const needsKey = Object.assign(new Error("not ready"), { code: "ENV_CONFIGURATION_REQUIRED" });
  const rate = Object.assign(new Error("slow down"), { code: "WORKSPACE_RATE_LIMIT_REACHED" });
  for (const [error, expected] of [[paused, "paused"], [needsKey, "needs_configuration"], [rate, "rate_limited"]]) {
    const { deps } = recorder({ startError: error });
    const result = await processPushDelivery(new FakeDb({ targets: [target()] }), push(), deps);
    assert.match(result.detail, new RegExp(`=${expected}$`));
  }
});

test("an unsupported project is never started", async () => {
  const { calls, deps } = recorder({ supported: false });
  const result = await processPushDelivery(new FakeDb({ targets: [target()] }), push(), deps);
  assert.match(result.detail, /unsupported/);
  assert.equal(calls.start.length, 0);
});
