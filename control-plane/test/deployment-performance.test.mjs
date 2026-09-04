import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeploymentPerformance, summarizeReadTimings } from "../src/deployment-performance.mjs";

function event(id, eventType, at, fromStatus, toStatus) {
  return { id, eventType, createdAt: at, fromStatus, toStatus, metadata: {} };
}

test("normalizes deployment stage timings from event history", () => {
  const result = normalizeDeploymentPerformance({
    deployment: {
      id: "deployment-1",
      appSlug: "dealup",
      createdAt: "2026-09-04T00:00:00.000Z",
      queuedAt: "2026-09-04T00:00:01.000Z",
      startedAt: "2026-09-04T00:00:03.000Z",
      finishedAt: "2026-09-04T00:00:50.000Z",
    },
    events: [
      event(7, "PUBLIC_ACCESS_VERIFIED", "2026-09-04T00:00:50.000Z", "HEALTH_CHECKING", "LIVE"),
      event(1, "ANALYSIS_STARTED", "2026-09-04T00:00:03.000Z", "QUEUED", "ANALYZING"),
      event(2, "ENV_REQUIREMENTS_VERIFIED", "2026-09-04T00:00:08.000Z", "ANALYZING", "PROVISIONING"),
      event(3, "RUNTIME_PROVISIONED", "2026-09-04T00:00:11.000Z", "PROVISIONING", "BUILDING"),
      event(4, "BUILD_STARTED", "2026-09-04T00:00:12.000Z", "BUILDING", "BUILDING"),
      event(5, "BUILD_SUCCEEDED", "2026-09-04T00:00:40.000Z", "BUILDING", "DEPLOYING"),
      event(6, "HEALTH_CHECK_STARTED", "2026-09-04T00:00:42.000Z", "DEPLOYING", "HEALTH_CHECKING"),
      event(8, "HEALTH_CHECK_PASSED", "2026-09-04T00:00:47.000Z", "HEALTH_CHECKING", "HEALTH_CHECKING"),
    ],
  });

  assert.deepEqual(result, {
    deploymentId: "deployment-1",
    appSlug: "dealup",
    totalDurationMs: 49000,
    queueLatencyMs: 2000,
    analysisDurationMs: 5000,
    provisioningDurationMs: 3000,
    buildDurationMs: 28000,
    healthDurationMs: 5000,
    publicAccessDurationMs: 3000,
    providerDominatedDurationMs: 31000,
    controlPlaneObservedDurationMs: 15000,
  });
});

test("returns null for ambiguous or incomplete stage timing", () => {
  const result = normalizeDeploymentPerformance({
    deployment: {
      id: "deployment-2",
      appSlug: "partial",
      queuedAt: "2026-09-04T00:00:01.000Z",
    },
    events: [
      event(1, "ANALYSIS_STARTED", "2026-09-04T00:00:03.000Z", "QUEUED", "ANALYZING"),
    ],
  });

  assert.equal(result.queueLatencyMs, 2000);
  assert.equal(result.analysisDurationMs, null);
  assert.equal(result.totalDurationMs, null);
  assert.equal(result.providerDominatedDurationMs, null);
});

test("summarizes read timing samples", () => {
  assert.deepEqual(summarizeReadTimings([
    { durationMs: 12 },
    { durationMs: 40 },
    { durationMs: 20 },
    { durationMs: 16 },
  ]), {
    count: 4,
    p50Ms: 16,
    maxMs: 40,
  });
});
