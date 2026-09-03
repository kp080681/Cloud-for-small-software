import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeploymentDiagnostic } from "../src/deployment-diagnostics.mjs";
import { normalizeDeploymentEvents, normalizeDeploymentTimeline } from "../src/deployment-timeline.mjs";

function context(overrides = {}) {
  return {
    deployment: {
      id: "dep_1",
      appId: "app_1",
      appSlug: "demo",
      status: "BUILDING",
      sourceCommitSha: "a".repeat(40),
      sourceBranch: "main",
      createdAt: "2026-09-03T00:00:00.000Z",
      startedAt: "2026-09-03T00:00:10.000Z",
      finishedAt: null,
      errorCode: null,
      ...overrides.deployment,
    },
    events: overrides.events ?? [],
    build: overrides.build ?? null,
    lastHealthCheck: overrides.lastHealthCheck ?? null,
    healthAttemptCount: overrides.healthAttemptCount ?? 0,
    envRequirementCount: overrides.envRequirementCount ?? 0,
    missingEnvCount: overrides.missingEnvCount ?? 0,
    missingEnvKeys: overrides.missingEnvKeys ?? [],
    envSnapshot: overrides.envSnapshot ?? null,
    policy: overrides.policy ?? { policyTier: "starter", maxBuildMinutes: 15, maxHealthAttempts: 3 },
    buildLogCount: overrides.buildLogCount ?? 0,
    buildErrorLogCount: overrides.buildErrorLogCount ?? 0,
    providerOperation: overrides.providerOperation ?? null,
  };
}

function timelineFor(input) {
  const diagnostic = normalizeDeploymentDiagnostic(input);
  return normalizeDeploymentTimeline(input, diagnostic);
}

test("timeline is chronological with deterministic event id tie-breaking", () => {
  const timeline = normalizeDeploymentEvents([
    { id: 4, eventType: "BUILD_STARTED", fromStatus: "BUILDING", toStatus: "BUILDING", metadata: {}, createdAt: "2026-09-03T00:00:02Z" },
    { id: 2, eventType: "ENV_REQUIREMENTS_VERIFIED", fromStatus: "ANALYZING", toStatus: "PROVISIONING", metadata: {}, createdAt: "2026-09-03T00:00:01Z" },
    { id: 1, eventType: "ENV_REQUIREMENTS_BLOCKED", fromStatus: "ANALYZING", toStatus: "ANALYZING", metadata: {}, createdAt: "2026-09-03T00:00:01Z" },
  ]);

  assert.deepEqual(timeline.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(timeline.map((event) => event.type), [
    "ENV_REQUIREMENTS_BLOCKED",
    "ENV_REQUIREMENTS_VERIFIED",
    "BUILD_STARTED",
  ]);
});

test("lifecycle transition events are categorized", () => {
  const timeline = normalizeDeploymentEvents([
    { id: 1, eventType: "STATUS_CHANGED", fromStatus: "READY", toStatus: "QUEUED", metadata: {}, createdAt: "2026-09-03T00:00:00Z" },
    { id: 2, eventType: "BUILD_INPUT_PREPARED", fromStatus: "ANALYZING", toStatus: "ANALYZING", metadata: { sourceCommitSha: "a".repeat(40) }, createdAt: "2026-09-03T00:00:01Z" },
  ]);

  assert.equal(timeline[0].category, "LIFECYCLE");
  assert.equal(timeline[0].title, "Deployment status changed");
  assert.equal(timeline[1].category, "LIFECYCLE");
});

test("repeated health check events remain separate", () => {
  const timeline = normalizeDeploymentEvents([
    { id: 1, eventType: "HEALTH_CHECK_PASSED", fromStatus: "HEALTH_CHECKING", toStatus: "HEALTH_CHECKING", metadata: { attemptNumber: 1 }, createdAt: "2026-09-03T00:00:01Z" },
    { id: 2, eventType: "HEALTH_CHECK_PASSED", fromStatus: "HEALTH_CHECKING", toStatus: "HEALTH_CHECKING", metadata: { attemptNumber: 2 }, createdAt: "2026-09-03T00:00:02Z" },
  ]);

  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].evidence.attemptNumber, 1);
  assert.equal(timeline[1].evidence.attemptNumber, 2);
});

test("historical env block remains visible while final diagnostic reflects health failure", () => {
  const result = timelineFor(context({
    deployment: { status: "FAILED", errorCode: "HEALTH_CHECK_FAILED", finishedAt: "2026-09-03T00:04:00Z" },
    healthAttemptCount: 3,
    lastHealthCheck: { attemptNumber: 3, status: "UNHEALTHY", httpStatus: 500, latencyMs: 99, errorCode: "HTTP_500" },
    events: [
      { id: 1, eventType: "ENV_REQUIREMENTS_BLOCKED", fromStatus: "ANALYZING", toStatus: "ANALYZING", metadata: { missingKeys: ["DATABASE_URL"] }, createdAt: "2026-09-03T00:01:00Z" },
      { id: 2, eventType: "ENV_REQUIREMENTS_VERIFIED", fromStatus: "ANALYZING", toStatus: "PROVISIONING", metadata: {}, createdAt: "2026-09-03T00:02:00Z" },
      { id: 3, eventType: "HEALTH_CHECK_FAILED", fromStatus: "HEALTH_CHECKING", toStatus: "FAILED", metadata: { attemptNumber: 3, httpStatus: 500 }, createdAt: "2026-09-03T00:03:00Z" },
    ],
  }));

  assert.equal(result.timeline[0].type, "ENV_REQUIREMENTS_BLOCKED");
  assert.equal(result.timeline[0].category, "ENVIRONMENT");
  assert.equal(result.diagnostic.severity, "FAILED");
  assert.equal(result.diagnostic.stage, "HEALTH");
  assert.equal(result.diagnostic.code, "HEALTH_CHECK_FAILED");
});

test("live deployment timeline returns diagnostic none", () => {
  const result = timelineFor(context({
    deployment: { status: "LIVE", liveUrl: "https://app.vercel.app", finishedAt: "2026-09-03T00:02:00Z" },
    events: [
      { id: 1, eventType: "BUILD_SUCCEEDED", fromStatus: "BUILDING", toStatus: "DEPLOYING", metadata: {}, createdAt: "2026-09-03T00:01:00Z" },
      { id: 2, eventType: "PUBLIC_ACCESS_VERIFIED", fromStatus: "HEALTH_CHECKING", toStatus: "LIVE", metadata: { checkUrl: "https://app.vercel.app" }, createdAt: "2026-09-03T00:02:00Z" },
    ],
  }));

  assert.equal(result.diagnostic.severity, "NONE");
  assert.equal(result.diagnostic.code, "DEPLOYMENT_LIVE");
  assert.equal(result.summary.reachedLive, true);
  assert.equal(result.summary.terminal, true);
});

test("deleted deployment with historical build failure retains build failure diagnostic", () => {
  const result = timelineFor(context({
    deployment: { status: "DELETED", errorCode: "BUILD_FAILED", finishedAt: "2026-09-03T00:02:00Z" },
    build: { providerDeploymentId: "dpl_1", sourceCommitSha: "a".repeat(40), status: "ERROR" },
    events: [
      { id: 1, eventType: "BUILD_FAILED", fromStatus: "BUILDING", toStatus: "FAILED", metadata: { providerDeploymentId: "dpl_1" }, createdAt: "2026-09-03T00:01:00Z" },
      { id: 2, eventType: "APP_DELETED", fromStatus: "FAILED", toStatus: "DELETED", metadata: {}, createdAt: "2026-09-03T00:02:00Z" },
    ],
  }));

  assert.equal(result.diagnostic.stage, "BUILD");
  assert.equal(result.diagnostic.code, "BUILD_FAILED");
  assert.equal(result.summary.terminal, true);
});

test("unknown event type degrades safely", () => {
  const timeline = normalizeDeploymentEvents([
    { id: 1, eventType: "NEW_THING_HAPPENED", fromStatus: "BUILDING", toStatus: "BUILDING", metadata: { providerDeploymentId: "dpl_1" }, createdAt: "2026-09-03T00:00:01Z" },
  ]);

  assert.equal(timeline[0].category, "OTHER");
  assert.equal(timeline[0].title, "Deployment event recorded");
  assert.equal(timeline[0].evidence.providerDeploymentId, "dpl_1");
});

test("metadata redaction removes secrets, values, raw logs, and provider bodies", () => {
  const timeline = normalizeDeploymentEvents([
    {
      id: 1,
      eventType: "BUILD_FAILED",
      fromStatus: "BUILDING",
      toStatus: "FAILED",
      metadata: {
        providerDeploymentId: "dpl_1",
        envValue: "postgres://secret",
        VERCEL_TOKEN: "token",
        providerBody: { raw: "body" },
        rawLogMessage: "log",
        valuesPrinted: false,
      },
      createdAt: "2026-09-03T00:00:01Z",
    },
  ]);

  const serialized = JSON.stringify(timeline);
  assert.equal(serialized.includes("dpl_1"), true);
  assert.equal(serialized.includes("postgres://secret"), false);
  assert.equal(serialized.includes("VERCEL_TOKEN"), false);
  assert.equal(serialized.includes("body"), false);
  assert.equal(serialized.includes("rawLogMessage"), false);
  assert.equal(serialized.includes("valuesPrinted"), false);
});

test("raw build logs and provider bodies are not surfaced", () => {
  const result = timelineFor(context({
    buildLogCount: 4,
    events: [
      { id: 1, eventType: "BUILD_LOGS_INGESTED", fromStatus: "BUILDING", toStatus: "BUILDING", metadata: { storedCount: 4, rawLog: "secret log", providerBody: { text: "body" } }, createdAt: "2026-09-03T00:01:00Z" },
    ],
  }));

  assert.equal(result.summary.buildLogCount, 4);
  assert.equal(result.timeline[0].evidence.storedCount, 4);
  assert.equal(JSON.stringify(result).includes("secret log"), false);
  assert.equal(JSON.stringify(result).includes("body"), false);
});

test("duration is calculated from started and finished timestamps", () => {
  const result = timelineFor(context({
    deployment: {
      status: "FAILED",
      errorCode: "BUILD_TIMEOUT",
      startedAt: "2026-09-03T00:00:10Z",
      finishedAt: "2026-09-03T00:02:40Z",
    },
  }));

  assert.equal(result.durationMs, 150000);
});

test("zero event history degrades safely", () => {
  const result = timelineFor(context({
    deployment: { status: "PROVISIONING" },
    events: [],
    build: null,
  }));

  assert.equal(result.timeline.length, 0);
  assert.equal(result.summary.eventCount, 0);
  assert.equal(result.summary.stateTransitionCount, 0);
  assert.equal(result.diagnostic.severity, "NONE");
});
