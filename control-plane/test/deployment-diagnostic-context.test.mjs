import assert from "node:assert/strict";
import test from "node:test";
import { loadDeploymentDiagnosticContext } from "../src/deployment-diagnostic-context.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryResult(sql) {
  if (sql.includes("FROM deployments d")) {
    return {
      rowCount: 1,
      rows: [{
        id: "deployment-1",
        deployment_key: "deployment-key",
        app_id: "app-1",
        status: "LIVE",
        source_commit_sha: "abc123",
        source_branch: "main",
        runtime_project_id: "runtime-1",
        provider_deployment_id: "provider-deployment-1",
        live_url: "https://example.com",
        error_code: null,
        created_at: new Date("2026-09-04T00:00:00Z"),
        queued_at: new Date("2026-09-04T00:00:01Z"),
        started_at: new Date("2026-09-04T00:00:02Z"),
        updated_at: new Date("2026-09-04T00:00:03Z"),
        finished_at: new Date("2026-09-04T00:00:04Z"),
        app_slug: "sample-app",
        policy_tier: "starter",
        max_build_minutes: 15,
        max_health_attempts: 3,
      }],
    };
  }
  if (sql.includes("FROM deployment_events")) return { rowCount: 0, rows: [] };
  if (sql.includes("FROM deployment_builds")) return { rowCount: 0, rows: [] };
  if (sql.includes("ORDER BY checked_at DESC")) return { rowCount: 0, rows: [] };
  if (sql.includes("FROM deployment_health_checks")) return { rowCount: 1, rows: [{ count: 0 }] };
  if (sql.includes("FROM app_env_requirements")) return { rowCount: 0, rows: [] };
  if (sql.includes("FROM deployment_env_detection_snapshots")) return { rowCount: 0, rows: [] };
  if (sql.includes("FROM deployment_logs")) return { rowCount: 1, rows: [{ total: 0, errors: 0 }] };
  if (sql.includes("FROM deployment_provider_operations")) return { rowCount: 0, rows: [] };
  throw new Error(`Unexpected query: ${sql}`);
}

function createTrackingDb({ poolLike = false } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const db = {
    async query(sql) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(1);
      inFlight -= 1;
      return queryResult(sql);
    },
  };

  if (poolLike) {
    db.connect = async () => ({ release() {} });
    db.totalCount = 0;
    db.idleCount = 0;
    db.waitingCount = 0;
  }

  return { db, maxInFlight: () => maxInFlight };
}

test("loads diagnostic context sequentially for a single Client-like connection", async () => {
  const { db, maxInFlight } = createTrackingDb();

  const context = await loadDeploymentDiagnosticContext(db, "deployment-1", { eventLimit: null });

  assert.equal(context.deployment.id, "deployment-1");
  assert.equal(maxInFlight(), 1);
});

test("loads independent diagnostic context reads concurrently for a Pool-like connection", async () => {
  const { db, maxInFlight } = createTrackingDb({ poolLike: true });

  const context = await loadDeploymentDiagnosticContext(db, "deployment-1", { eventLimit: null });

  assert.equal(context.deployment.id, "deployment-1");
  assert.ok(maxInFlight() > 1);
});
