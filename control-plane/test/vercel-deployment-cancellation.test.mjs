import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  cancelVercelDeployment,
  isTerminalVercelDeploymentStatus,
  recordRemoteBuildContainment,
  RemoteContainment,
} from "../src/vercel-deployment-cancellation.mjs";

const root = path.resolve(import.meta.dirname, "..");

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 400 ? "Error" : "OK",
    headers: { "content-type": "application/json" },
  });
}

function sequenceFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected fetch call: ${url}`);
      return jsonResponse(next.status, next.body);
    },
  };
}

function eventDb({ existingFinal = null } = {}) {
  const events = [];
  return {
    events,
    async query(sql, params) {
      if (/SELECT event_type, metadata/.test(sql)) {
        return existingFinal ? { rowCount: 1, rows: [existingFinal] } : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO deployment_events/.test(sql)) {
        events.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in cancellation test: ${sql}`);
    },
  };
}

test("timeout cancellation of provider BUILDING requests cancel once and confirms containment", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    { status: 200, body: { readyState: "BUILDING" } },
    { status: 200, body: { readyState: "CANCELED" } },
  ]);

  const outcome = await cancelVercelDeployment({
    providerDeploymentId: "dpl_a",
    token: "provider-token",
    fetchImpl,
  });

  assert.equal(outcome.remoteContainment, RemoteContainment.CANCEL_CONFIRMED);
  assert.equal(outcome.providerStatus, "CANCELED");
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).pathname, "/v12/deployments/dpl_a/cancel");
  assert.equal(calls[1].init.method, "PATCH");
  assert.equal(calls[1].init.headers.Authorization, "Bearer provider-token");
});

test("cancellation replay is idempotent when provider is already canceled", async () => {
  const first = sequenceFetch([
    { status: 200, body: { readyState: "BUILDING" } },
    { status: 200, body: { readyState: "CANCELED" } },
  ]);
  const second = sequenceFetch([
    { status: 200, body: { readyState: "CANCELED" } },
  ]);

  const firstOutcome = await cancelVercelDeployment({ providerDeploymentId: "dpl_a", token: "token", fetchImpl: first.fetchImpl });
  const secondOutcome = await cancelVercelDeployment({ providerDeploymentId: "dpl_a", token: "token", fetchImpl: second.fetchImpl });

  assert.equal(firstOutcome.remoteContainment, RemoteContainment.CANCEL_CONFIRMED);
  assert.equal(secondOutcome.remoteContainment, RemoteContainment.ALREADY_TERMINAL);
  assert.equal(second.calls.some((call) => new URL(call.url).pathname.endsWith("/cancel")), false);
});

test("provider READY before cancel is recorded as already terminal, not cancelled", async () => {
  const { fetchImpl, calls } = sequenceFetch([{ status: 200, body: { readyState: "READY" } }]);

  const outcome = await cancelVercelDeployment({ providerDeploymentId: "dpl_ready", token: "token", fetchImpl });

  assert.equal(outcome.remoteContainment, RemoteContainment.ALREADY_TERMINAL);
  assert.equal(outcome.providerStatus, "READY");
  assert.equal(calls.length, 1);
});

test("provider ERROR or CANCELED are terminal without unnecessary mutation", () => {
  assert.equal(isTerminalVercelDeploymentStatus("ERROR"), true);
  assert.equal(isTerminalVercelDeploymentStatus("CANCELED"), true);
  assert.equal(isTerminalVercelDeploymentStatus("BUILDING"), false);
});

test("provider NOT_FOUND is safe when delete/project removal wins the race", async () => {
  const { fetchImpl } = sequenceFetch([{ status: 404, body: { error: { code: "not_found" } } }]);

  const outcome = await cancelVercelDeployment({ providerDeploymentId: "dpl_deleted", token: "token", fetchImpl });

  assert.equal(outcome.remoteContainment, RemoteContainment.ALREADY_TERMINAL);
  assert.equal(outcome.providerStatus, "NOT_FOUND");
  assert.equal(outcome.retryable, false);
});

test("transient cancellation failure is visible as pending reconciliation", async () => {
  const { fetchImpl } = sequenceFetch([
    { status: 200, body: { readyState: "BUILDING" } },
    { status: 500, body: { error: { code: "internal" } } },
    { status: 200, body: { readyState: "BUILDING" } },
  ]);

  const outcome = await cancelVercelDeployment({ providerDeploymentId: "dpl_transient", token: "token", fetchImpl });

  assert.equal(outcome.remoteContainment, RemoteContainment.CANCEL_PENDING_RECONCILIATION);
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.providerStatus, "BUILDING");
});

test("network failure is normalized as pending reconciliation evidence", async () => {
  const outcome = await cancelVercelDeployment({
    providerDeploymentId: "dpl_network",
    token: "token",
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });

  assert.equal(outcome.remoteContainment, RemoteContainment.CANCEL_PENDING_RECONCILIATION);
  assert.equal(outcome.retryable, true);
});

test("authorization failure is visible as containment failure", async () => {
  const { fetchImpl } = sequenceFetch([
    { status: 200, body: { readyState: "BUILDING" } },
    { status: 403, body: { error: { code: "forbidden" } } },
    { status: 200, body: { readyState: "BUILDING" } },
  ]);

  const outcome = await cancelVercelDeployment({ providerDeploymentId: "dpl_forbidden", token: "token", fetchImpl });

  assert.equal(outcome.remoteContainment, RemoteContainment.CONTAINMENT_FAILED);
  assert.equal(outcome.retryable, false);
});

test("cancellation of one deployment cannot target an unrelated deployment", async () => {
  const { fetchImpl, calls } = sequenceFetch([
    { status: 200, body: { readyState: "BUILDING" } },
    { status: 200, body: { readyState: "CANCELED" } },
  ]);

  await cancelVercelDeployment({ providerDeploymentId: "dpl_a", token: "token", fetchImpl });

  assert.equal(calls.every((call) => call.url.includes("dpl_a")), true);
  assert.equal(calls.some((call) => call.url.includes("dpl_b")), false);
});

test("remote containment evidence is recorded once and never stores provider body", async () => {
  const db = eventDb();
  const result = await recordRemoteBuildContainment(db, {
    deploymentId: "deployment-a",
    fromStatus: "BUILDING",
    providerDeploymentId: "dpl_a",
    reason: "BUILD_TIMEOUT",
    cancelDeployment: async () => ({
      providerDeploymentId: "dpl_a",
      providerStatus: "CANCELED",
      remoteContainment: RemoteContainment.CANCEL_CONFIRMED,
      retryable: false,
      cancelRequestSent: true,
      providerHttpStatus: 200,
      reason: "provider-cancel-confirmed",
    }),
  });

  assert.equal(result.outcome.remoteContainment, RemoteContainment.CANCEL_CONFIRMED);
  assert.equal(db.events.length, 2);
  assert.match(db.events[0].params[2], /providerDeploymentId/);
  assert.doesNotMatch(JSON.stringify(db.events), /providerBody|provider-token|raw/i);
});

test("remote containment replay reuses final evidence and does not cancel again", async () => {
  const db = eventDb({
    existingFinal: {
      event_type: "PROVIDER_CANCEL_CONFIRMED",
      metadata: { remoteContainment: RemoteContainment.CANCEL_CONFIRMED, providerDeploymentId: "dpl_a" },
    },
  });
  let cancelCalls = 0;

  const result = await recordRemoteBuildContainment(db, {
    deploymentId: "deployment-a",
    fromStatus: "FAILED",
    providerDeploymentId: "dpl_a",
    reason: "BUILD_TIMEOUT",
    cancelDeployment: async () => {
      cancelCalls += 1;
    },
  });

  assert.equal(result.alreadyRecorded, true);
  assert.equal(result.outcome.remoteContainment, RemoteContainment.CANCEL_CONFIRMED);
  assert.equal(cancelCalls, 0);
  assert.equal(db.events.length, 0);
});

test("non-retryable containment failure is replay-safe until operator action", async () => {
  const db = eventDb({
    existingFinal: {
      event_type: "PROVIDER_CANCEL_FAILED",
      metadata: {
        remoteContainment: RemoteContainment.CONTAINMENT_FAILED,
        providerDeploymentId: "dpl_a",
        retryable: false,
      },
    },
  });
  let cancelCalls = 0;

  const result = await recordRemoteBuildContainment(db, {
    deploymentId: "deployment-a",
    fromStatus: "FAILED",
    providerDeploymentId: "dpl_a",
    reason: "BUILD_TIMEOUT",
    cancelDeployment: async () => {
      cancelCalls += 1;
    },
  });

  assert.equal(result.alreadyRecorded, true);
  assert.equal(result.outcome.remoteContainment, RemoteContainment.CONTAINMENT_FAILED);
  assert.equal(cancelCalls, 0);
});

test("retryable pending containment may be retried on replay", async () => {
  const db = eventDb({
    existingFinal: {
      event_type: "PROVIDER_CANCEL_FAILED",
      metadata: {
        remoteContainment: RemoteContainment.CANCEL_PENDING_RECONCILIATION,
        providerDeploymentId: "dpl_a",
        retryable: true,
      },
    },
  });
  let cancelCalls = 0;

  const result = await recordRemoteBuildContainment(db, {
    deploymentId: "deployment-a",
    fromStatus: "FAILED",
    providerDeploymentId: "dpl_a",
    reason: "BUILD_TIMEOUT",
    cancelDeployment: async () => {
      cancelCalls += 1;
      return {
        providerDeploymentId: "dpl_a",
        providerStatus: "CANCELED",
        remoteContainment: RemoteContainment.CANCEL_CONFIRMED,
        retryable: false,
        cancelRequestSent: true,
      };
    },
  });

  assert.equal(result.alreadyRecorded, false);
  assert.equal(result.outcome.remoteContainment, RemoteContainment.CANCEL_CONFIRMED);
  assert.equal(cancelCalls, 1);
});

test("orchestrator uses persisted build timestamp instead of resetting timeout on retry", () => {
  const source = fs.readFileSync(path.join(root, "trigger/orchestrate-deployment.ts"), "utf8");

  assert.match(source, /b\.created_at AS build_created_at/);
  assert.match(source, /function buildElapsedMs/);
  assert.doesNotMatch(source, /const buildStartedAt\s*=\s*Date\.now\(\)/);
  assert.match(source, /recordRemoteBuildContainment/);
});

test("abandon path attempts remote containment for attached provider deployments and terminal replay", () => {
  const source = fs.readFileSync(path.join(root, "trigger/abandon-deployment.ts"), "utf8");

  assert.match(source, /recordRemoteBuildContainment/);
  assert.match(source, /DEPLOYMENT_ABANDONED/);
  assert.match(source, /DEPLOYMENT_ABANDON_TERMINAL_NOOP/);
  assert.match(source, /provider_deployment_id/);
});
