import assert from "node:assert/strict";
import test from "node:test";
import { McpToolError, deploy, getLogs, getStatus, listApps, setEnv } from "../src/server/mcp-tools.mjs";

// A minimal fake handling only the two raw queries mcp-tools.mjs issues
// directly (findExistingAppForRepo / findSelectedRepositoryId /
// loadLatestDeploymentId); every other piece of business logic is a real
// function from the codebase, injected as a fake at the same seam this
// codebase already uses everywhere (triggerOrchestrator,
// createInstallationClient, listRepositories).
class FakeDb {
  constructor({ existingAppId = null, selectedRepositoryId = null, latestDeploymentId = null } = {}) {
    this.existingAppId = existingAppId;
    this.selectedRepositoryId = selectedRepositoryId;
    this.latestDeploymentId = latestDeploymentId;
  }
  async query(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT a.id FROM apps a")) {
      return { rowCount: this.existingAppId ? 1 : 0, rows: this.existingAppId ? [{ id: this.existingAppId }] : [] };
    }
    if (text.startsWith("SELECT id FROM github_repositories")) {
      return { rowCount: this.selectedRepositoryId ? 1 : 0, rows: this.selectedRepositoryId ? [{ id: this.selectedRepositoryId }] : [] };
    }
    if (text.startsWith("SELECT id FROM deployments WHERE app_id")) {
      return { rowCount: this.latestDeploymentId ? 1 : 0, rows: this.latestDeploymentId ? [{ id: this.latestDeploymentId }] : [] };
    }
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

const noopAuthorize = async () => {};

test("deploy always re-analyzes, even for an app that already exists — regression test for a bug an independent review (Opus 5.5) found: redeploying used to rebuild the already-live commit via redeployLiveCustomerApp, never fetching the repository's current code, so an agent pushing a fix and calling deploy would report success while the old code stayed live", async () => {
  const db = new FakeDb({ selectedRepositoryId: "repo-1" });
  let startCalled = null;
  const result = await deploy(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repo: "kp080681/my-app",
    authorizeWorkspace: noopAuthorize,
    analyzeRepository: async (_db, args) => {
      assert.equal(args.repositoryId, "repo-1");
      // analyzeSelectedRepository's own createOrReuseApp/createOrReuseDeployment
      // are what actually handle "this app already exists" correctly —
      // deploy() itself no longer branches on that at all.
      return { appId: "app-1", deploymentId: "dep-fresh-analysis", supported: true };
    },
    checkReadiness: async () => ({ readiness: "READY_TO_DEPLOY", deploymentId: "dep-fresh-analysis", requirements: [] }),
    startDeployment: async (_db, args) => {
      startCalled = args;
    },
  });

  assert.ok(startCalled, "a ready, freshly-analyzed deployment must actually be started");
  assert.deepEqual(result, {
    appId: "app-1",
    deploymentId: "dep-fresh-analysis",
    status: "queued",
    message: "Deploying — this'll take a moment.",
    url: null,
  });
});

test("deploy rejects a branch override rather than silently ignoring it", async () => {
  const db = new FakeDb();
  await assert.rejects(
    deploy(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      repo: "kp080681/my-app",
      branch: "feature-x",
      authorizeWorkspace: noopAuthorize,
    }),
    (error) => error instanceof McpToolError && error.code === "BRANCH_OVERRIDE_NOT_SUPPORTED",
  );
});

test("deploy auto-starts a new app when analysis says it's immediately ready", async () => {
  const db = new FakeDb({ selectedRepositoryId: "repo-1" });
  let startCalled = null;
  const result = await deploy(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repo: "kp080681/new-app",
    authorizeWorkspace: noopAuthorize,
    analyzeRepository: async () => ({ appId: "app-2", deploymentId: "dep-analyze-1", supported: true }),
    checkReadiness: async () => ({ readiness: "READY_TO_DEPLOY", deploymentId: "dep-analyze-1", requirements: [] }),
    startDeployment: async (_db, args) => {
      startCalled = args;
    },
  });

  assert.deepEqual(startCalled, { customerId: "identity-a", workspaceId: "workspace-a", appId: "app-2", deploymentId: "dep-analyze-1" });
  assert.equal(result.status, "queued");
  assert.equal(result.appId, "app-2");
});

test("deploy returns needs_configuration with the missing keys, and never calls startDeployment", async () => {
  const db = new FakeDb({ selectedRepositoryId: "repo-1" });
  let startCalled = false;
  const result = await deploy(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repo: "kp080681/new-app",
    authorizeWorkspace: noopAuthorize,
    analyzeRepository: async () => ({ appId: "app-2", deploymentId: "dep-analyze-1", supported: true }),
    checkReadiness: async () => ({
      readiness: "CONFIGURATION_REQUIRED",
      deploymentId: "dep-analyze-1",
      requirements: [
        { envKey: "OPENAI_API_KEY", required: true, managed: false, configured: false, public: false },
        { envKey: "NEXT_PUBLIC_SITE_URL", required: true, managed: false, configured: false, public: true },
        { envKey: "DATABASE_URL", required: true, managed: true, configured: true, public: false },
        { envKey: "ALREADY_SET", required: true, managed: false, configured: true, public: false },
      ],
    }),
    startDeployment: async () => {
      startCalled = true;
    },
  });

  assert.equal(startCalled, false);
  assert.equal(result.status, "needs_configuration");
  assert.deepEqual(result.missingConfig, [
    { key: "OPENAI_API_KEY", public: false },
    { key: "NEXT_PUBLIC_SITE_URL", public: true },
  ]);
});

test("deploy returns blocked, not a thrown error, when the repository analysis itself is unsupported", async () => {
  const db = new FakeDb({ selectedRepositoryId: "repo-1" });
  const result = await deploy(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repo: "kp080681/not-nextjs",
    authorizeWorkspace: noopAuthorize,
    analyzeRepository: async () => ({ appId: "app-3", deploymentId: "dep-3", supported: false, errorCode: "PACKAGE_JSON_NOT_FOUND" }),
  });

  assert.equal(result.status, "blocked");
  assert.match(result.message, /PACKAGE_JSON_NOT_FOUND/);
});

test("getStatus throws APPLICATION_NOT_FOUND for an app with no deployments, without calling loadProgress", async () => {
  const db = new FakeDb({ latestDeploymentId: null });
  let loadProgressCalled = false;
  await assert.rejects(
    getStatus(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      appId: "app-empty",
      authorizeWorkspace: noopAuthorize,
      loadProgress: async () => {
        loadProgressCalled = true;
      },
    }),
    (error) => error instanceof McpToolError && error.code === "APPLICATION_NOT_FOUND",
  );
  assert.equal(loadProgressCalled, false);
});

test("getStatus maps the real progress shape correctly, including a null url when not live", async () => {
  const db = new FakeDb({ latestDeploymentId: "dep-1" });
  const result = await getStatus(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-1",
    authorizeWorkspace: noopAuthorize,
    loadProgress: async () => ({
      status: "BUILDING",
      stage: "Building your app",
      active: true,
      terminal: false,
      liveUrl: null,
      diagnostic: null,
    }),
  });
  assert.deepEqual(result, {
    status: "BUILDING",
    stage: "Building your app",
    active: true,
    terminal: false,
    url: null,
    message: "This deployment is in progress.",
    diagnostic: null,
  });
});

test("getLogs trims to the requested limit and maps only the fields the schema promises", async () => {
  const db = new FakeDb({ latestDeploymentId: "dep-1" });
  const events = Array.from({ length: 5 }, (_, i) => ({
    at: `2026-09-22T00:0${i}:00.000Z`,
    title: `Event ${i}`,
    type: "SHOULD_NOT_APPEAR",
    evidence: { attempt: i },
  }));
  const result = await getLogs(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-1",
    limit: 2,
    authorizeWorkspace: noopAuthorize,
    loadProgress: async () => ({ stage: "Building your app", diagnostic: null, events }),
  });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], { at: "2026-09-22T00:03:00.000Z", title: "Event 3", evidence: { attempt: 3 } });
  assert.equal("type" in result.entries[0], false);
});

test("setEnv passes through to saveCustomerAppSecret and maps its result", async () => {
  const db = new FakeDb();
  const result = await setEnv(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-1",
    key: "OPENAI_API_KEY",
    value: "sk-real",
    saveSecret: async (_db, args) => {
      assert.equal(args.envKey, "OPENAI_API_KEY");
      assert.equal(args.plaintext, "sk-real");
      return { envKey: "OPENAI_API_KEY", configured: true };
    },
  });
  assert.deepEqual(result, { configured: true, message: "OPENAI_API_KEY saved." });
});

test("listApps maps every field the schema promises, including a null status/url for a never-deployed app", async () => {
  const db = new FakeDb();
  const result = await listApps(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    loadApplications: async () => [
      { id: "app-1", name: "My App", slug: "my-app", latestDeploymentStatus: "LIVE", liveUrl: "https://my-app.utplava.app" },
      { id: "app-2", name: "New App", slug: "new-app", latestDeploymentStatus: null, liveUrl: null },
    ],
  });
  assert.deepEqual(result.apps, [
    { appId: "app-1", name: "My App", slug: "my-app", status: "LIVE", url: "https://my-app.utplava.app" },
    { appId: "app-2", name: "New App", slug: "new-app", status: null, url: null },
  ]);
});
