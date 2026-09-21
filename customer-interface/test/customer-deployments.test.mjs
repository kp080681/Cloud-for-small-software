import assert from "node:assert/strict";
import test from "node:test";
import {
  customerResumeStaleThresholdMs,
  deploymentResumeIdempotencyKey,
  deploymentStartIdempotencyKey,
  getCustomerDeploymentProgress,
  getCustomerDeploymentProgressWithResume,
  redeployLiveCustomerApp,
  retryFailedCustomerDeployment,
  resumeCustomerDeployment,
  startCustomerDeployment,
  triggerDeploymentOrchestrator,
} from "../src/server/customer-deployments.mjs";
import { redeployFailureMessage, retrySuccessMessage } from "../src/shared/deployment-ui-state.mjs";

class FakeDb {
  constructor() {
    this.workspaces = [{ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" }];
    this.memberships = [{ customerId: "identity-a", workspaceId: "workspace-a" }];
    this.apps = [{
      id: "app-a",
      workspace_id: "workspace-a",
      repository_id: "repo-a",
      name: "App A",
      slug: "app-a",
      database_required: false,
      database_mode: "NONE",
      deleted_at: null,
      created_at: 1,
    }];
    this.deployments = [{
      id: "deployment-a",
      deployment_key: "dep_a",
      workspace_id: "workspace-a",
      app_id: "app-a",
      status: "ANALYZING",
      error_code: null,
      source_commit_sha: "a".repeat(40),
      source_branch: "main",
      parent_deployment_id: null,
      orchestrator_run_id: null,
      live_url: null,
      provider_deployment_id: null,
      created_at: 1,
      updated_at: new Date("2026-09-10T00:00:00.000Z"),
    }];
    this.buildInputs = [{
      id: "build-input-a",
      deployment_id: "deployment-a",
      build_command: "npm run build",
    }];
    this.requirements = [];
    this.bindings = [];
    this.detections = [];
    this.events = [{
      id: 1,
      deployment_id: "deployment-a",
      event_type: "PROJECT_ANALYSIS_COMPLETED",
      from_status: "ANALYZING",
      to_status: "ANALYZING",
      metadata: { sourceCommitSha: "a".repeat(40), token: "must-not-leak" },
      created_at: new Date("2026-09-10T00:00:00.000Z"),
    }];
    this.queries = [];
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    this.queries.push({ text, params });

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rowCount: 0, rows: [] };

    if (text.includes("FROM customer_workspace_memberships cwm") && text.includes("AND w.id = $2")) {
      const [customerId, workspaceId] = params;
      const authorized = this.memberships.some(
        (membership) => membership.customerId === customerId && membership.workspaceId === workspaceId,
      );
      const workspace = authorized ? this.workspaces.find((row) => row.id === workspaceId) : null;
      return { rowCount: workspace ? 1 : 0, rows: workspace ? [workspace] : [] };
    }

    if (text.includes("FROM apps a") && text.includes("live_deployment_id")) {
      const [workspaceId, appId] = params;
      const app = this.apps.find((row) => row.workspace_id === workspaceId && row.id === appId && !row.deleted_at);
      if (!app) return { rowCount: 0, rows: [] };
      const live = this.deployments
        .filter((row) => row.app_id === appId && row.status === "LIVE")
        .sort((a, b) => b.created_at - a.created_at)[0];
      return {
        rowCount: 1,
        rows: [{
          id: app.id,
          workspace_id: app.workspace_id,
          deleted_at: app.deleted_at,
          live_deployment_id: live?.id ?? null,
          live_source_commit_sha: live?.source_commit_sha ?? null,
          live_source_branch: live?.source_branch ?? null,
        }],
      };
    }

    if (
      text.includes("FROM deployments d") &&
      text.includes("LEFT JOIN deployment_build_inputs") &&
      text.includes("WHERE d.app_id = $1") &&
      text.includes("d.status = ANY")
    ) {
      assert.equal(text.includes("d.status = ANY($2::deployment_status[])"), true);
      const [appId, statuses] = params;
      const deployment = this.deployments
        .filter((row) => row.app_id === appId && statuses.includes(row.status))
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!deployment) return { rowCount: 0, rows: [] };
      const input = this.buildInputs.find((row) => row.deployment_id === deployment.id);
      return {
        rowCount: 1,
        rows: [{
          ...deployment,
          latest_event_at: this.latestEventAt(deployment.id),
          app_deleted_at: null,
          build_input_id: input?.id ?? null,
          build_command: input?.build_command ?? null,
        }],
      };
    }

    if (
      text.includes("FROM deployments d") &&
      text.includes("LEFT JOIN deployment_build_inputs") &&
      text.includes("WHERE d.app_id = $1") &&
      text.includes("AND d.id = $2")
    ) {
      const [appId, deploymentId] = params;
      const deployment = this.deployments.find((row) => row.app_id === appId && row.id === deploymentId);
      if (!deployment) return { rowCount: 0, rows: [] };
      const input = this.buildInputs.find((row) => row.deployment_id === deployment.id);
      return {
        rowCount: 1,
        rows: [{ ...deployment, latest_event_at: this.latestEventAt(deployment.id), build_input_id: input?.id ?? null }],
      };
    }

    if (
      text.includes("FROM deployments d") &&
      text.includes("LEFT JOIN deployment_build_inputs") &&
      text.includes("WHERE d.app_id = $1") &&
      !text.includes("d.parent_deployment_id = $2")
    ) {
      const [appId] = params;
      const deployment = this.deployments
        .filter((row) => row.app_id === appId)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!deployment) return { rowCount: 0, rows: [] };
      const input = this.buildInputs.find((row) => row.deployment_id === deployment.id);
      return { rowCount: 1, rows: [{ ...deployment, latest_event_at: this.latestEventAt(deployment.id), build_input_id: input?.id ?? null }] };
    }

    if (text.includes("FROM apps") && text.includes("workspace_id = $1") && text.includes("id = $2")) {
      const [workspaceId, appId] = params;
      const app = this.apps.find((row) => row.workspace_id === workspaceId && row.id === appId);
      return { rowCount: app ? 1 : 0, rows: app ? [app] : [] };
    }

    if (text.includes("FROM app_env_requirements r")) {
      const [appId] = params;
      const rows = this.requirements
        .filter((row) => row.app_id === appId)
        .map((row) => ({
          ...row,
          configured: this.bindings.some(
            (binding) => binding.app_id === appId && binding.env_key === row.env_key,
          ),
        }));
      return { rowCount: rows.length, rows };
    }

    if (text.includes("FROM deployment_env_requirement_detections det")) {
      const [deploymentId] = params;
      const rows = this.detections.filter((row) => row.deployment_id === deploymentId);
      return { rowCount: rows.length, rows };
    }

    if (text.includes("FROM deployments d") && text.includes("JOIN apps a") && text.includes("d.id = $3")) {
      const [workspaceId, appId, deploymentId] = params;
      const deployment = this.deployments.find(
        (row) => row.workspace_id === workspaceId && row.app_id === appId && row.id === deploymentId,
      );
      if (!deployment) return { rowCount: 0, rows: [] };
      const app = this.apps.find((row) => row.id === appId);
      const input = this.buildInputs.find((row) => row.deployment_id === deploymentId);
      return {
        rowCount: 1,
        rows: [{
          ...deployment,
          latest_event_at: this.latestEventAt(deployment.id),
          app_deleted_at: app?.deleted_at ?? null,
          build_input_id: input?.id ?? null,
          build_command: input?.build_command ?? null,
        }],
      };
    }

    if (text.startsWith("SELECT id FROM deployments WHERE app_id = $1")) {
      const [appId] = params;
      const deployment = this.deployments
        .filter((row) => row.app_id === appId)
        .sort((a, b) => b.created_at - a.created_at)[0];
      return { rowCount: deployment ? 1 : 0, rows: deployment ? [{ id: deployment.id }] : [] };
    }

    if (text.includes("FROM deployments d") && text.includes("d.parent_deployment_id = $2")) {
      const [appId, parentDeploymentId] = params;
      const deployments = this.deployments
        .filter((row) => row.app_id === appId && row.parent_deployment_id === parentDeploymentId)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, text.includes("LIMIT 2") ? 2 : 1);
      if (deployments.length === 0) return { rowCount: 0, rows: [] };
      return {
        rowCount: deployments.length,
        rows: deployments.map((deployment) => {
          const input = this.buildInputs.find((row) => row.deployment_id === deployment.id);
          return {
            ...deployment,
            latest_event_at: this.latestEventAt(deployment.id),
            app_deleted_at: null,
            build_input_id: input?.id ?? null,
            build_command: input?.build_command ?? null,
          };
        }),
      };
    }

    if (text.startsWith("INSERT INTO deployments") && text.includes("parent_deployment_id")) {
      const [deploymentKey, workspaceId, appId, commitSha, branch, parentDeploymentId] = params;
      const deployment = {
        id: `deployment-retry-${this.deployments.length}`,
        deployment_key: deploymentKey,
        workspace_id: workspaceId,
        app_id: appId,
        status: "ANALYZING",
        error_code: null,
        source_commit_sha: commitSha,
        source_branch: branch,
        parent_deployment_id: parentDeploymentId,
        orchestrator_run_id: null,
        live_url: null,
        provider_deployment_id: null,
        created_at: Math.max(...this.deployments.map((row) => row.created_at)) + 1,
        updated_at: new Date("2026-09-10T00:00:00.000Z"),
      };
      this.deployments.push(deployment);
      return { rowCount: 1, rows: [deployment] };
    }

    if (text.startsWith("UPDATE deployments SET orchestrator_run_id = $1")) {
      const [runId, deploymentId, expected] = params;
      const deployment = this.deployments.find((row) => row.id === deploymentId);
      if (!deployment) return { rowCount: 0, rows: [] };
      if (text.includes("AND status = $3")) {
        if (deployment.status !== expected || deployment.error_code) return { rowCount: 0, rows: [] };
        deployment.orchestrator_run_id = runId;
        deployment.updated_at = new Date();
        return { rowCount: 1, rows: [{ id: deployment.id }] };
      }
      if (params.length === 2 || deployment.orchestrator_run_id === null || deployment.orchestrator_run_id === expected || deployment.orchestrator_run_id === runId) {
        deployment.orchestrator_run_id = runId;
        deployment.updated_at = new Date();
        return { rowCount: 1, rows: [{ id: deployment.id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (text.startsWith("UPDATE deployments SET orchestrator_run_id = NULL")) {
      const [deploymentId, marker] = params;
      const deployment = this.deployments.find((row) => row.id === deploymentId);
      if (deployment?.orchestrator_run_id === marker) {
        deployment.orchestrator_run_id = null;
        deployment.updated_at = new Date();
        return { rowCount: 1, rows: [{ id: deployment.id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (text.includes("INSERT INTO deployment_events")) {
      const deploymentId = params[0];
      const message = params.at(-2);
      const metadata = params.at(-1);
      const explicitEventType = params.length >= 6 ? params[3] : null;
      const eventTypeMatch = text.match(/'([A-Z_]+)'/g);
      const eventType = explicitEventType
        ?? eventTypeMatch?.map((value) => value.replaceAll("'", "")).find((value) => value.endsWith("_CREATED"))
        ?? "STATUS_CHANGED";
      this.events.push({
        id: this.events.length + 1,
        deployment_id: deploymentId,
        event_type: eventType,
        from_status: params.length >= 6 ? params[1] : "DRAFT",
        to_status: params.length >= 6 ? params[2] : "ANALYZING",
        message,
        metadata: metadata ? JSON.parse(metadata) : {},
        created_at: new Date("2026-09-10T00:00:01.000Z"),
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("FROM deployment_events")) {
      const [deploymentId, limit] = params;
      const rows = this.events
        .filter((row) => row.deployment_id === deploymentId)
        .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
        .slice(0, limit);
      return { rowCount: rows.length, rows };
    }

    if (text.startsWith("INSERT INTO workspace_rate_limit_counters")) {
      const [workspaceId, action, windowStart] = params;
      this.rateLimitCounters ??= new Map();
      const key = `${workspaceId}:${action}:${windowStart}`;
      const next = (this.rateLimitCounters.get(key) ?? 0) + 1;
      this.rateLimitCounters.set(key, next);
      return { rowCount: 1, rows: [{ count: next }] };
    }

    throw new Error(`Unhandled fake query: ${text}`);
  }

  latestEventAt(deploymentId) {
    const latest = this.events
      .filter((row) => row.deployment_id === deploymentId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    return latest?.created_at ?? null;
  }
}

function startArgs(overrides = {}) {
  return {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    deploymentId: "deployment-a",
    ...overrides,
  };
}

function makeDeploymentStale(db, status) {
  db.deployments[0].status = status;
  db.deployments[0].error_code = null;
  db.deployments[0].orchestrator_run_id = "run-exited";
  db.deployments[0].updated_at = new Date("2026-09-10T00:00:00.000Z");
  db.events = db.events.map((event) => ({
    ...event,
    created_at: new Date("2026-09-10T00:00:00.000Z"),
  }));
}

function addRetryDeployment(db, overrides = {}) {
  const deployment = {
    id: overrides.id ?? `deployment-${db.deployments.length}`,
    deployment_key: overrides.deployment_key ?? `dep_${db.deployments.length}`,
    workspace_id: overrides.workspace_id ?? "workspace-a",
    app_id: overrides.app_id ?? "app-a",
    status: overrides.status ?? "FAILED",
    error_code: overrides.error_code ?? (overrides.status === "FAILED" || !overrides.status ? "HEALTH_CHECK_FAILED" : null),
    source_commit_sha: overrides.source_commit_sha ?? "a".repeat(40),
    source_branch: overrides.source_branch ?? "main",
    parent_deployment_id: overrides.parent_deployment_id ?? "deployment-a",
    orchestrator_run_id: overrides.orchestrator_run_id ?? null,
    live_url: overrides.live_url ?? null,
    provider_deployment_id: overrides.provider_deployment_id ?? null,
    created_at: overrides.created_at ?? db.deployments.length + 1,
    updated_at: overrides.updated_at ?? new Date("2026-09-10T00:00:00.000Z"),
  };
  db.deployments.push(deployment);
  return deployment;
}

test("ready deployment invokes the approved orchestrator with deterministic idempotency", async () => {
  const db = new FakeDb();
  const calls = [];
  const deployment = await startCustomerDeployment(db, {
    ...startArgs(),
    triggerOrchestrator: async (input) => {
      calls.push(input);
      return { id: "run-a" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].deploymentId, "deployment-a");
  assert.equal(calls[0].idempotencyKey, deploymentStartIdempotencyKey("deployment-a"));
  assert.equal(db.deployments[0].orchestrator_run_id, "run-a");
  assert.equal(deployment.start.started, true);
  assert.equal(JSON.stringify(calls).includes("npm run build"), false);
});

test("cross-workspace and arbitrary deployment start are denied", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => startCustomerDeployment(db, { ...startArgs({ workspaceId: "workspace-b" }), triggerOrchestrator: async () => ({ id: "run" }) }),
    /Workspace not found/,
  );
  await assert.rejects(
    () => startCustomerDeployment(db, { ...startArgs({ deploymentId: "deployment-other" }), triggerOrchestrator: async () => ({ id: "run" }) }),
    /Deployment is not the current deployment/,
  );
});

test("not-ready deployment cannot start", async () => {
  const db = new FakeDb();
  db.requirements.push({
    id: "requirement-a",
    workspace_id: "workspace-a",
    app_id: "app-a",
    env_key: "API_KEY",
    required: true,
    public: false,
    source: "user-confirmed",
  });

  await assert.rejects(
    () => startCustomerDeployment(db, { ...startArgs(), triggerOrchestrator: async () => ({ id: "run" }) }),
    /Deployment is not ready/,
  );
});

test("active and live deployment starts are idempotent no-ops", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "BUILDING";
  db.deployments[0].orchestrator_run_id = "run-existing";
  let triggerCount = 0;
  const active = await startCustomerDeployment(db, {
    ...startArgs(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-new" };
    },
  });

  db.deployments[0].status = "LIVE";
  db.deployments[0].live_url = "https://example.vercel.app";
  const live = await startCustomerDeployment(db, {
    ...startArgs(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-new" };
    },
  });

  assert.equal(triggerCount, 0);
  assert.equal(active.start.alreadyStarted, true);
  assert.equal(active.status, "BUILDING");
  assert.equal(live.liveUrl, "https://example.vercel.app");
});

test("Trigger invocation failure clears the start marker for safe retry", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => startCustomerDeployment(db, {
      ...startArgs(),
      triggerOrchestrator: async () => {
        throw Object.assign(new Error("trigger down"), { code: "TRIGGER_DOWN" });
      },
    }),
    /trigger down/,
  );

  assert.equal(db.deployments[0].orchestrator_run_id, null);
});

test("progress read enforces tenancy and redacts unsafe event metadata", async () => {
  const db = new FakeDb();
  db.events.push({
    id: 2,
    deployment_id: "deployment-a",
    event_type: "DEPLOYMENT_RESUME_REQUESTED",
    from_status: "ANALYZING",
    to_status: "ANALYZING",
    metadata: { responseBodyStored: false },
    created_at: new Date("2026-09-10T00:00:01.000Z"),
  });
  const progress = await getCustomerDeploymentProgress(db, startArgs());

  assert.equal(progress.deploymentId, "deployment-a");
  assert.equal(progress.status, "ANALYZING");
  assert.equal(progress.active, false);
  assert.equal(progress.stage, "Preparing deployment");
  assert.equal(JSON.stringify(progress).includes("must-not-leak"), false);
  assert.equal(progress.events.some((event) => event.type === "DEPLOYMENT_RESUME_REQUESTED"), true);
  await assert.rejects(
    () => getCustomerDeploymentProgress(db, startArgs({ workspaceId: "workspace-b" })),
    /Workspace not found/,
  );
});

test("Trigger HTTP boundary sends only fixed task, deployment id, and idempotency key", async () => {
  const calls = [];
  const handle = await triggerDeploymentOrchestrator({
    deploymentId: "deployment-a",
    idempotencyKey: "ui06:orchestrate:deployment-a",
    env: {
      TRIGGER_SECRET_KEY: "secret-value",
      TRIGGER_API_URL: "https://trigger.test",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ id: "run-a" }),
      };
    },
  });

  assert.equal(handle.id, "run-a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://trigger.test/api/v1/tasks/ssc-control-plane-orchestrate-deployment/trigger");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.payload, { deploymentId: "deployment-a" });
  assert.equal(body.options.idempotencyKey, "ui06:orchestrate:deployment-a");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-value");
  assert.equal(JSON.stringify(body).includes("sourceCommitSha"), false);
  assert.equal(JSON.stringify(body).includes("providerProjectId"), false);
});

for (const status of ["ANALYZING", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING"]) {
  test(`stale ${status} deployment resumes the same deployment`, async () => {
    const db = new FakeDb();
    makeDeploymentStale(db, status);
    const calls = [];
    const deployment = await resumeCustomerDeployment(db, {
      ...startArgs(),
      staleAfterMs: 1000,
      now: new Date("2026-09-10T00:10:00.000Z").getTime(),
      triggerOrchestrator: async (input) => {
        calls.push(input);
        return { id: `run-resume-${status}` };
      },
    });

    assert.equal(deployment.deploymentId, "deployment-a");
    assert.equal(deployment.sourceCommitSha, "a".repeat(40));
    assert.equal(db.deployments.length, 1);
    assert.equal(db.deployments[0].status, status);
    assert.equal(db.deployments[0].orchestrator_run_id, `run-resume-${status}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].deploymentId, "deployment-a");
    const marker = db.events.find((event) => event.event_type === "DEPLOYMENT_RESUME_REQUESTED").metadata.resumeMarker;
    assert.equal(calls[0].idempotencyKey, deploymentResumeIdempotencyKey("deployment-a", marker));
    assert.equal(deployment.resume.started, true);
    assert.equal(db.events.some((event) => event.event_type === "DEPLOYMENT_RESUME_REQUESTED"), true);
    assert.equal(db.events.some((event) => event.event_type === "DEPLOYMENT_RESUME_STARTED"), true);
  });
}

test("polling can automatically resume a stale deployment and suppress repeated requests", async () => {
  const db = new FakeDb();
  makeDeploymentStale(db, "HEALTH_CHECKING");
  let triggerCount = 0;

  const first = await getCustomerDeploymentProgressWithResume(db, {
    ...startArgs(),
    staleAfterMs: 1000,
    now: new Date("2026-09-10T00:10:00.000Z").getTime(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-resume" };
    },
  });
  const second = await getCustomerDeploymentProgressWithResume(db, {
    ...startArgs(),
    staleAfterMs: 1000,
    now: new Date("2026-09-10T00:10:01.000Z").getTime(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-duplicate" };
    },
  });

  assert.equal(first.resume.started, true);
  assert.equal(second.resume.started, false);
  assert.equal(second.resume.suppressed, true);
  assert.equal(triggerCount, 1);
  assert.equal(db.events.filter((event) => event.event_type === "DEPLOYMENT_RESUME_REQUESTED").length, 1);
});

test("recent active deployment does not unnecessarily resume", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "BUILDING";
  db.deployments[0].orchestrator_run_id = "run-active";
  db.deployments[0].updated_at = new Date("2026-09-10T00:09:59.000Z");
  let triggerCount = 0;

  const deployment = await getCustomerDeploymentProgressWithResume(db, {
    ...startArgs(),
    staleAfterMs: 5000,
    now: new Date("2026-09-10T00:10:00.000Z").getTime(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-should-not-start" };
    },
  });

  assert.equal(triggerCount, 0);
  assert.equal(deployment.resume.reason, "recent-progress");
});

test("normal resume stale threshold remains five minutes by default", () => {
  assert.equal(customerResumeStaleThresholdMs(), 5 * 60 * 1000);
});

test("explicit stale threshold override remains a direct server parameter only", () => {
  assert.equal(customerResumeStaleThresholdMs({ staleAfterMs: 1000 }), 1000);
});

test("default production threshold does not resume a recently stale-looking deployment", async () => {
  const db = new FakeDb();
  makeDeploymentStale(db, "ANALYZING");
  db.deployments[0].updated_at = new Date("2026-09-10T00:09:20.000Z");
  db.events = db.events.map((event) => ({
    ...event,
    created_at: new Date("2026-09-10T00:09:20.000Z"),
  }));
  let triggerCount = 0;

  const deployment = await getCustomerDeploymentProgressWithResume(db, {
    ...startArgs(),
    now: new Date("2026-09-10T00:10:00.000Z").getTime(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-resume" };
    },
  });

  assert.equal(triggerCount, 0);
  assert.equal(deployment.deploymentId, "deployment-a");
  assert.equal(deployment.resume.started, false);
  assert.equal(deployment.resume.reason, "recent-progress");
});

test("live failed and configuration-blocked deployments cannot resume", async () => {
  for (const status of ["LIVE", "FAILED"]) {
    const db = new FakeDb();
    makeDeploymentStale(db, status);
    let triggerCount = 0;
    const deployment = await getCustomerDeploymentProgressWithResume(db, {
      ...startArgs(),
      staleAfterMs: 1000,
      now: new Date("2026-09-10T00:10:00.000Z").getTime(),
      triggerOrchestrator: async () => {
        triggerCount += 1;
        return { id: "run-should-not-start" };
      },
    });
    assert.equal(triggerCount, 0);
    assert.equal(deployment.resume.reason, "not-resumable-status");
  }

  const db = new FakeDb();
  makeDeploymentStale(db, "ANALYZING");
  db.deployments[0].error_code = "ENV_CONFIGURATION_REQUIRED";
  const deployment = await getCustomerDeploymentProgressWithResume(db, {
    ...startArgs(),
    staleAfterMs: 1000,
    now: new Date("2026-09-10T00:10:00.000Z").getTime(),
    triggerOrchestrator: async () => {
      throw new Error("should not trigger");
    },
  });
  assert.equal(deployment.resume.reason, "deployment-has-error");
});

test("deployment without immutable source identity cannot resume", async () => {
  const db = new FakeDb();
  makeDeploymentStale(db, "ANALYZING");
  db.deployments[0].source_commit_sha = null;
  let triggerCount = 0;

  const deployment = await getCustomerDeploymentProgressWithResume(db, {
    ...startArgs(),
    staleAfterMs: 1000,
    now: new Date("2026-09-10T00:10:00.000Z").getTime(),
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-should-not-start" };
    },
  });

  assert.equal(triggerCount, 0);
  assert.equal(deployment.resume.reason, "source-identity-missing");
});

test("resume enforces workspace and deployment ownership", async () => {
  const db = new FakeDb();
  makeDeploymentStale(db, "PROVISIONING");
  await assert.rejects(
    () => resumeCustomerDeployment(db, {
      ...startArgs({ workspaceId: "workspace-b" }),
      staleAfterMs: 1000,
      now: new Date("2026-09-10T00:10:00.000Z").getTime(),
      triggerOrchestrator: async () => ({ id: "run" }),
    }),
    /Workspace not found/,
  );
  await assert.rejects(
    () => resumeCustomerDeployment(db, {
      ...startArgs({ appId: "app-other" }),
      staleAfterMs: 1000,
      now: new Date("2026-09-10T00:10:00.000Z").getTime(),
      triggerOrchestrator: async () => ({ id: "run" }),
    }),
    /Deployment not found/,
  );
});

test("resume Trigger failure clears marker and records failure evidence", async () => {
  const db = new FakeDb();
  makeDeploymentStale(db, "BUILDING");

  await assert.rejects(
    () => resumeCustomerDeployment(db, {
      ...startArgs(),
      staleAfterMs: 1000,
      now: new Date("2026-09-10T00:10:00.000Z").getTime(),
      triggerOrchestrator: async () => {
        throw new Error("trigger down");
      },
    }),
    /trigger down/,
  );

  assert.equal(db.deployments[0].orchestrator_run_id, null);
  assert.equal(db.events.some((event) => event.event_type === "DEPLOYMENT_RESUME_FAILED"), true);
  assert.equal(JSON.stringify(db.events).includes("secret"), false);
});

test("failed deployment retry creates a new same-source child and leaves parent unchanged", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  db.deployments[0].live_url = "https://old.example";
  db.deployments[0].provider_deployment_id = "dpl_old";
  const calls = [];

  const deployment = await retryFailedCustomerDeployment(db, {
    ...startArgs(),
    deploymentKeyFactory: () => "dep_retry",
    triggerOrchestrator: async (input) => {
      calls.push(input);
      return { id: "run-retry" };
    },
  });
  const parent = db.deployments.find((row) => row.id === "deployment-a");
  const child = db.deployments.find((row) => row.id === deployment.deploymentId);

  assert.equal(db.deployments.length, 2);
  assert.equal(parent.status, "FAILED");
  assert.equal(parent.error_code, "HEALTH_CHECK_FAILED");
  assert.notEqual(child.id, parent.id);
  assert.equal(child.deployment_key, "dep_retry");
  assert.equal(child.workspace_id, parent.workspace_id);
  assert.equal(child.app_id, parent.app_id);
  assert.equal(child.source_commit_sha, parent.source_commit_sha);
  assert.equal(child.source_branch, parent.source_branch);
  assert.equal(child.parent_deployment_id, parent.id);
  assert.equal(child.status, "ANALYZING");
  assert.equal(child.error_code, null);
  assert.equal(child.live_url, null);
  assert.equal(child.provider_deployment_id, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deploymentId, child.id);
  assert.equal(calls[0].idempotencyKey, deploymentStartIdempotencyKey(child.id));
  assert.equal(deployment.retry.created, true);
  assert.equal(JSON.stringify(deployment).includes("dpl_old"), false);
});

test("failed deployment retry returns an existing active child without creating another", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  db.deployments.push({
    id: "deployment-child",
    deployment_key: "dep_child",
    workspace_id: "workspace-a",
    app_id: "app-a",
    status: "BUILDING",
    error_code: null,
    source_commit_sha: "a".repeat(40),
    source_branch: "main",
    parent_deployment_id: "deployment-a",
    orchestrator_run_id: "run-child",
    live_url: null,
    provider_deployment_id: null,
    created_at: 2,
  });
  let triggerCount = 0;

  const deployment = await retryFailedCustomerDeployment(db, {
    ...startArgs(),
    deploymentKeyFactory: () => "dep_should_not_create",
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-new" };
    },
  });

  assert.equal(db.deployments.length, 2);
  assert.equal(deployment.deploymentId, "deployment-child");
  assert.equal(deployment.status, "BUILDING");
  assert.equal(deployment.retry.created, false);
  assert.equal(deployment.retry.alreadyStarted, true);
  assert.equal(triggerCount, 0);
});

test("failed deployment retry returns a live child", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  addRetryDeployment(db, {
    id: "deployment-child",
    deployment_key: "dep_child",
    status: "LIVE",
    error_code: null,
    parent_deployment_id: "deployment-a",
    orchestrator_run_id: "run-child",
    live_url: "https://child.example",
    created_at: 2,
  });

  const live = await retryFailedCustomerDeployment(db, {
    ...startArgs(),
    triggerOrchestrator: async () => {
      throw new Error("should not trigger");
    },
  });
  assert.equal(live.deploymentId, "deployment-child");
  assert.equal(live.status, "LIVE");
  assert.equal(live.liveUrl, "https://child.example");
});

test("stale ancestor retry resolves failed child and creates the next bounded attempt", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  addRetryDeployment(db, {
    id: "deployment-b",
    deployment_key: "dep_b",
    status: "FAILED",
    parent_deployment_id: "deployment-a",
    created_at: 2,
  });
  const calls = [];

  const deployment = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-a" }),
    deploymentKeyFactory: () => "dep_c",
    triggerOrchestrator: async (input) => {
      calls.push(input);
      return { id: "run-c" };
    },
  });
  const child = db.deployments.find((row) => row.id === deployment.deploymentId);

  assert.equal(db.deployments.length, 3);
  assert.equal(child.deployment_key, "dep_c");
  assert.equal(child.parent_deployment_id, "deployment-b");
  assert.equal(child.source_commit_sha, "a".repeat(40));
  assert.equal(child.source_branch, "main");
  assert.equal(deployment.retry.requestedDeploymentId, "deployment-a");
  assert.equal(deployment.retry.parentDeploymentId, "deployment-b");
  assert.equal(deployment.retry.retryDepth, 2);
  assert.equal(deployment.retry.created, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deploymentId, child.id);
});

test("retrying the failed child converges on the same next-attempt behavior", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  addRetryDeployment(db, {
    id: "deployment-b",
    deployment_key: "dep_b",
    status: "FAILED",
    parent_deployment_id: "deployment-a",
    created_at: 2,
  });

  const deployment = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-b" }),
    deploymentKeyFactory: () => "dep_c",
    triggerOrchestrator: async () => ({ id: "run-c" }),
  });
  const child = db.deployments.find((row) => row.id === deployment.deploymentId);

  assert.equal(db.deployments.length, 3);
  assert.equal(child.parent_deployment_id, "deployment-b");
  assert.equal(deployment.retry.retryDepth, 2);
  assert.equal(deployment.retry.created, true);
});

test("stale ancestor retry can create the third and final retry attempt", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  addRetryDeployment(db, { id: "deployment-b", deployment_key: "dep_b", status: "FAILED", parent_deployment_id: "deployment-a", created_at: 2 });
  addRetryDeployment(db, { id: "deployment-c", deployment_key: "dep_c", status: "FAILED", parent_deployment_id: "deployment-b", created_at: 3 });

  const deployment = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-a" }),
    deploymentKeyFactory: () => "dep_d",
    triggerOrchestrator: async () => ({ id: "run-d" }),
  });
  const child = db.deployments.find((row) => row.id === deployment.deploymentId);

  assert.equal(db.deployments.length, 4);
  assert.equal(child.deployment_key, "dep_d");
  assert.equal(child.parent_deployment_id, "deployment-c");
  assert.equal(deployment.retry.retryDepth, 3);
});

test("retry limit returns stable response without mutating history or triggering", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  addRetryDeployment(db, { id: "deployment-b", deployment_key: "dep_b", status: "FAILED", parent_deployment_id: "deployment-a", created_at: 2 });
  addRetryDeployment(db, { id: "deployment-c", deployment_key: "dep_c", status: "FAILED", parent_deployment_id: "deployment-b", created_at: 3 });
  addRetryDeployment(db, { id: "deployment-d", deployment_key: "dep_d", status: "FAILED", parent_deployment_id: "deployment-c", created_at: 4 });
  let triggerCount = 0;

  const fromRoot = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-a" }),
    deploymentKeyFactory: () => "dep_should_not_create",
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-should-not-start" };
    },
  });
  const fromLatest = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-d" }),
    deploymentKeyFactory: () => "dep_should_not_create_latest",
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-should-not-start" };
    },
  });

  assert.equal(db.deployments.length, 4);
  assert.equal(triggerCount, 0);
  assert.equal(fromRoot.deploymentId, "deployment-d");
  assert.equal(fromLatest.deploymentId, "deployment-d");
  assert.equal(fromRoot.retry.limitReached, true);
  assert.equal(fromRoot.retry.code, "DEPLOYMENT_RETRY_LIMIT_REACHED");
  assert.equal(fromRoot.retry.retryDepth, 3);
  assert.equal(JSON.stringify(fromRoot).includes("provider_deployment_id"), false);
});

test("active and live descendants are returned from stale ancestor retry", async () => {
  for (const [status, expected] of [["BUILDING", { active: true, liveUrl: null }], ["LIVE", { active: false, liveUrl: "https://child.example" }]]) {
    const db = new FakeDb();
    db.deployments[0].status = "FAILED";
    db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
    addRetryDeployment(db, {
      id: "deployment-b",
      deployment_key: "dep_b",
      status,
      error_code: null,
      parent_deployment_id: "deployment-a",
      orchestrator_run_id: "run-b",
      live_url: expected.liveUrl,
      created_at: 2,
    });
    let triggerCount = 0;

    const deployment = await retryFailedCustomerDeployment(db, {
      ...startArgs({ deploymentId: "deployment-a" }),
      triggerOrchestrator: async () => {
        triggerCount += 1;
        return { id: "run-should-not-start" };
      },
    });

    assert.equal(db.deployments.length, 2);
    assert.equal(triggerCount, 0);
    assert.equal(deployment.deploymentId, "deployment-b");
    assert.equal(deployment.status, status);
    assert.equal(deployment.active, expected.active);
    assert.equal(deployment.liveUrl, expected.liveUrl);
    assert.equal(deployment.retry.alreadyStarted, true);
  }
});

test("retry lineage stays linear and preserves source identity across attempts", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  db.deployments[0].source_commit_sha = "f".repeat(40);
  db.deployments[0].source_branch = "release";
  const keys = ["dep_b", "dep_c", "dep_d"];
  const first = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-a" }),
    deploymentKeyFactory: () => keys.shift(),
    triggerOrchestrator: async () => ({ id: "run-b" }),
  });
  db.deployments.find((row) => row.id === first.deploymentId).status = "FAILED";
  const second = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: "deployment-a" }),
    deploymentKeyFactory: () => keys.shift(),
    triggerOrchestrator: async () => ({ id: "run-c" }),
  });
  db.deployments.find((row) => row.id === second.deploymentId).status = "FAILED";
  const third = await retryFailedCustomerDeployment(db, {
    ...startArgs({ deploymentId: first.deploymentId }),
    deploymentKeyFactory: () => keys.shift(),
    triggerOrchestrator: async () => ({ id: "run-d" }),
  });

  assert.deepEqual(db.deployments.map((row) => row.parent_deployment_id), [null, "deployment-a", first.deploymentId, second.deploymentId]);
  assert.equal(third.retry.retryDepth, 3);
  for (const deployment of db.deployments) {
    assert.equal(deployment.source_commit_sha, "f".repeat(40));
    assert.equal(deployment.source_branch, "release");
  }
});

test("retry lineage corruption fails closed", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  db.deployments[0].parent_deployment_id = "deployment-b";
  addRetryDeployment(db, {
    id: "deployment-b",
    deployment_key: "dep_b",
    status: "FAILED",
    parent_deployment_id: "deployment-a",
    created_at: 2,
  });

  await assert.rejects(
    () => retryFailedCustomerDeployment(db, { ...startArgs(), triggerOrchestrator: async () => ({ id: "run" }) }),
    /cyclic|corrupted/i,
  );
});

test("ambiguous retry lineage fails closed", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";
  addRetryDeployment(db, {
    id: "deployment-b",
    deployment_key: "dep_b",
    status: "FAILED",
    parent_deployment_id: "deployment-a",
    created_at: 2,
  });
  addRetryDeployment(db, {
    id: "deployment-c",
    deployment_key: "dep_c",
    status: "FAILED",
    parent_deployment_id: "deployment-a",
    created_at: 3,
  });

  await assert.rejects(
    () => retryFailedCustomerDeployment(db, { ...startArgs(), triggerOrchestrator: async () => ({ id: "run" }) }),
    /multiple direct children/i,
  );
});

test("retry success copy reflects existing live child instead of claiming a new retry", () => {
  assert.equal(
    retrySuccessMessage({
      status: "LIVE",
      retry: { created: false, started: false, alreadyStarted: true },
    }),
    "Existing deployment is live.",
  );
  assert.equal(
    retrySuccessMessage({
      status: "BUILDING",
      retry: { created: false, started: false, alreadyStarted: true },
    }),
    "Existing deployment resumed.",
  );
  assert.equal(
    retrySuccessMessage({
      status: "ANALYZING",
      retry: { created: true, started: true, alreadyStarted: false },
    }),
    "Deployment retry started.",
  );
  assert.equal(
    retrySuccessMessage({
      status: "FAILED",
      retry: { limitReached: true },
    }),
    "Retry limit reached. Review the deployment details before trying a new deployment.",
  );
});

test("redeploy failure copy is safe and customer-actionable", () => {
  assert.equal(redeployFailureMessage("42883"), "Redeployment could not be started. Please try again.");
  assert.equal(redeployFailureMessage("REDEPLOYMENT_INSERT_FAILED"), "Redeployment could not be started. Please try again.");
});

test("failed deployment retry denies cross-workspace, non-failed, and stale parent attempts", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => retryFailedCustomerDeployment(db, { ...startArgs({ workspaceId: "workspace-b" }), triggerOrchestrator: async () => ({ id: "run" }) }),
    /Workspace not found/,
  );
  await assert.rejects(
    () => retryFailedCustomerDeployment(db, { ...startArgs(), triggerOrchestrator: async () => ({ id: "run" }) }),
    /Only failed deployments/,
  );

  db.deployments[0].status = "FAILED";
  db.deployments.push({
    id: "deployment-newer",
    deployment_key: "dep_newer",
    workspace_id: "workspace-a",
    app_id: "app-a",
    status: "ANALYZING",
    error_code: null,
    source_commit_sha: "b".repeat(40),
    source_branch: "main",
    parent_deployment_id: null,
    orchestrator_run_id: null,
    live_url: null,
    provider_deployment_id: null,
    created_at: 2,
  });
  await assert.rejects(
    () => retryFailedCustomerDeployment(db, { ...startArgs(), triggerOrchestrator: async () => ({ id: "run" }) }),
    /latest analysed deployment/,
  );
});

test("retry trigger failure clears only the child start marker", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "FAILED";
  db.deployments[0].error_code = "HEALTH_CHECK_FAILED";

  await assert.rejects(
    () => retryFailedCustomerDeployment(db, {
      ...startArgs(),
      triggerOrchestrator: async () => {
        throw new Error("trigger down");
      },
    }),
    /trigger down/,
  );

  const child = db.deployments.find((row) => row.parent_deployment_id === "deployment-a");
  assert.equal(db.deployments[0].status, "FAILED");
  assert.equal(child.orchestrator_run_id, null);
});

test("live app redeploy creates a fresh same-source deployment and leaves live parent unchanged", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "LIVE";
  db.deployments[0].live_url = "https://app.example";
  db.deployments[0].orchestrator_run_id = "run-live";
  const calls = [];

  const deployment = await redeployLiveCustomerApp(db, {
    ...startArgs({ deploymentId: undefined }),
    deploymentKeyFactory: () => "dep_redeploy",
    triggerOrchestrator: async (input) => {
      calls.push(input);
      return { id: "run-redeploy" };
    },
  });
  const parent = db.deployments.find((row) => row.id === "deployment-a");
  const child = db.deployments.find((row) => row.id === deployment.deploymentId);

  assert.equal(db.deployments.length, 2);
  assert.equal(parent.status, "LIVE");
  assert.equal(parent.live_url, "https://app.example");
  assert.notEqual(child.id, parent.id);
  assert.equal(child.deployment_key, "dep_redeploy");
  assert.equal(child.workspace_id, parent.workspace_id);
  assert.equal(child.app_id, parent.app_id);
  assert.equal(child.source_commit_sha, parent.source_commit_sha);
  assert.equal(child.source_branch, parent.source_branch);
  assert.equal(child.parent_deployment_id, parent.id);
  assert.equal(child.status, "ANALYZING");
  assert.equal(child.error_code, null);
  assert.equal(child.live_url, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deploymentId, child.id);
  assert.equal(calls[0].idempotencyKey, deploymentStartIdempotencyKey(child.id));
  assert.equal(deployment.redeploy.created, true);
  assert.equal(deployment.redeploy.started, true);
  assert.equal(deployment.redeploy.parentDeploymentId, parent.id);
  assert.equal(db.events.some((event) => event.deployment_id === child.id && event.event_type === "REDEPLOY_CREATED"), true);
  assert.equal(JSON.stringify(calls).includes("TRIGGER_SECRET_KEY"), false);
});

test("live app redeploy reuses active redeployment so duplicate clicks do not fan out", async () => {
  const db = new FakeDb();
  db.deployments[0].status = "LIVE";
  db.deployments[0].live_url = "https://app.example";
  db.deployments[0].orchestrator_run_id = "run-live";
  db.deployments.push({
    id: "deployment-active",
    deployment_key: "dep_active",
    workspace_id: "workspace-a",
    app_id: "app-a",
    status: "BUILDING",
    error_code: null,
    source_commit_sha: "a".repeat(40),
    source_branch: "main",
    parent_deployment_id: "deployment-a",
    orchestrator_run_id: "run-active",
    live_url: null,
    provider_deployment_id: null,
    created_at: 2,
    updated_at: new Date("2026-09-10T00:00:00.000Z"),
  });
  let triggerCount = 0;

  const deployment = await redeployLiveCustomerApp(db, {
    ...startArgs({ deploymentId: undefined }),
    deploymentKeyFactory: () => "dep_should_not_create",
    triggerOrchestrator: async () => {
      triggerCount += 1;
      return { id: "run-new" };
    },
  });

  assert.equal(db.deployments.length, 2);
  assert.equal(deployment.deploymentId, "deployment-active");
  assert.equal(deployment.status, "BUILDING");
  assert.equal(deployment.redeploy.created, false);
  assert.equal(deployment.redeploy.reusedActive, true);
  assert.equal(deployment.redeploy.alreadyStarted, true);
  assert.equal(triggerCount, 0);
});

test("live app redeploy enforces authorization and requires an existing live deployment", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () => redeployLiveCustomerApp(db, {
      ...startArgs({ workspaceId: "workspace-b", deploymentId: undefined }),
      triggerOrchestrator: async () => ({ id: "run" }),
    }),
    /Workspace not found/,
  );

  await assert.rejects(
    () => redeployLiveCustomerApp(db, {
      ...startArgs({ deploymentId: undefined }),
      triggerOrchestrator: async () => ({ id: "run" }),
    }),
    /Redeploy requires an existing live deployment/,
  );
});
