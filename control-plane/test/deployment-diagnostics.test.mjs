import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeploymentDiagnostic } from "../src/deployment-diagnostics.mjs";

function baseContext(overrides = {}) {
  return {
    deployment: {
      id: "dep_1",
      status: "BUILDING",
      sourceCommitSha: "a".repeat(40),
      errorCode: null,
      ...overrides.deployment,
    },
    events: overrides.events ?? [],
    build: overrides.build ?? {
      providerDeploymentId: "dpl_1",
      providerDeploymentUrl: "https://example.vercel.app",
      sourceCommitSha: "a".repeat(40),
      status: "BUILDING",
    },
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

test("env configuration required is blocked with missing keys but no values", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "ANALYZING", errorCode: "ENV_CONFIGURATION_REQUIRED" },
    missingEnvCount: 2,
    missingEnvKeys: ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
    envRequirementCount: 3,
    envSnapshot: { id: "snap_1", detectedCount: 4 },
  }));

  assert.equal(diagnostic.severity, "BLOCKED");
  assert.equal(diagnostic.stage, "ENVIRONMENT");
  assert.equal(diagnostic.code, "ENV_CONFIGURATION_REQUIRED");
  assert.equal(diagnostic.retryable, true);
  assert.deepEqual(diagnostic.evidence.missingKeys, ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
  assert.equal(JSON.stringify(diagnostic).includes("postgres://secret-value"), false);
});

test("build timeout is a failed build diagnostic", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "BUILD_TIMEOUT" },
    events: [{ eventType: "BUILD_TIMEOUT", metadata: { maxBuildMinutes: 2 }, createdAt: "2026-09-03T00:00:00Z" }],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "BUILD");
  assert.equal(diagnostic.code, "BUILD_TIMEOUT");
  assert.equal(diagnostic.evidence.maxBuildMinutes, 2);
});

test("provider build failure points to stored build logs without returning raw logs", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "BUILD_FAILED" },
    buildLogCount: 10,
    buildErrorLogCount: 3,
    events: [{
      eventType: "BUILD_FAILED",
      metadata: { providerDeploymentId: "dpl_1", rawLogMessage: "do not leak" },
      createdAt: "2026-09-03T00:00:00Z",
    }],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "BUILD");
  assert.equal(diagnostic.code, "BUILD_FAILED");
  assert.equal(diagnostic.evidence.buildLogCount, 10);
  assert.equal(JSON.stringify(diagnostic).includes("do not leak"), false);
});

test("source mismatch explains immutable build identity failure", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "BUILD_SOURCE_MISMATCH" },
    events: [{
      eventType: "BUILD_SOURCE_MISMATCH",
      metadata: { expectedCommitSha: "a".repeat(40), observedCommitSha: "b".repeat(40) },
      createdAt: "2026-09-03T00:00:00Z",
    }],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "BUILD");
  assert.equal(diagnostic.code, "BUILD_SOURCE_MISMATCH");
  assert.equal(diagnostic.retryable, false);
  assert.equal(diagnostic.evidence.expectedCommitSha, "a".repeat(40));
  assert.equal(diagnostic.evidence.observedCommitSha, "b".repeat(40));
});

test("health exhaustion includes last safe health status", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "HEALTH_CHECK_FAILED" },
    healthAttemptCount: 3,
    lastHealthCheck: { attemptNumber: 3, status: "UNHEALTHY", httpStatus: 500, latencyMs: 812, errorCode: "HTTP_500" },
    events: [{
      eventType: "HEALTH_CHECK_FAILED",
      metadata: { attemptNumber: 3, httpStatus: 500, latencyMs: 812, errorCode: "HTTP_500", responseBodyStored: false },
      createdAt: "2026-09-03T00:00:00Z",
    }],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "HEALTH");
  assert.equal(diagnostic.code, "HEALTH_CHECK_FAILED");
  assert.equal(diagnostic.evidence.lastHttpStatus, 500);
  assert.equal(diagnostic.evidence.responseBodyStored, false);
});

test("public access blocked is represented as blocked while deployment is not live", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "HEALTH_CHECKING" },
    events: [{
      eventType: "PUBLIC_ACCESS_BLOCKED",
      metadata: {
        checkUrl: "https://app.vercel.app",
        httpStatus: 302,
        redirectLocationHost: "vercel.com",
        vercelAuthRedirect: true,
        responseBodyStored: false,
      },
      createdAt: "2026-09-03T00:00:00Z",
    }],
  }));

  assert.equal(diagnostic.severity, "BLOCKED");
  assert.equal(diagnostic.stage, "PUBLIC_ACCESS");
  assert.equal(diagnostic.code, "PUBLIC_ACCESS_BLOCKED");
  assert.equal(diagnostic.evidence.vercelAuthRedirect, true);
});

test("resolved env block does not override later health failure", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "HEALTH_CHECK_FAILED" },
    healthAttemptCount: 3,
    lastHealthCheck: { attemptNumber: 3, status: "UNHEALTHY", httpStatus: 500, latencyMs: 100, errorCode: "HTTP_500" },
    events: [
      { eventType: "HEALTH_CHECK_FAILED", metadata: { attemptNumber: 3, httpStatus: 500 }, createdAt: "2026-09-03T00:03:00Z" },
      { eventType: "ENV_REQUIREMENTS_VERIFIED", metadata: {}, createdAt: "2026-09-03T00:02:00Z" },
      { eventType: "ENV_REQUIREMENTS_BLOCKED", metadata: { missingKeys: ["DATABASE_URL"] }, createdAt: "2026-09-03T00:01:00Z" },
    ],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "HEALTH");
  assert.equal(diagnostic.code, "HEALTH_CHECK_FAILED");
});

test("resolved env block does not create an env diagnostic for in-progress deployment", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "PROVISIONING" },
    build: null,
    events: [
      { eventType: "ENV_REQUIREMENTS_VERIFIED", metadata: {}, createdAt: "2026-09-03T00:02:00Z" },
      { eventType: "ENV_REQUIREMENTS_BLOCKED", metadata: { missingKeys: ["DATABASE_URL"] }, createdAt: "2026-09-03T00:01:00Z" },
    ],
  }));

  assert.equal(diagnostic.severity, "NONE");
  assert.equal(diagnostic.code, "NO_CURRENT_ISSUE");
});

test("unresolved env block remains blocked while deployment is analyzing", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "ANALYZING" },
    build: null,
    events: [
      { eventType: "ENV_REQUIREMENTS_BLOCKED", metadata: { missingKeys: ["DATABASE_URL"], missingCount: 1 }, createdAt: "2026-09-03T00:01:00Z" },
    ],
  }));

  assert.equal(diagnostic.severity, "BLOCKED");
  assert.equal(diagnostic.stage, "ENVIRONMENT");
  assert.equal(diagnostic.code, "ENV_CONFIGURATION_REQUIRED");
});

test("historical policy block does not override later unrelated terminal failure", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "BUILD_FAILED" },
    events: [
      { eventType: "BUILD_FAILED", metadata: { providerDeploymentId: "dpl_1" }, createdAt: "2026-09-03T00:03:00Z" },
      { eventType: "BUILD_STARTED", metadata: { providerDeploymentId: "dpl_1" }, createdAt: "2026-09-03T00:02:00Z" },
      { eventType: "RESOURCE_POLICY_BLOCKED", metadata: { violations: [{ code: "ENV_VAR_LIMIT_EXCEEDED" }] }, createdAt: "2026-09-03T00:01:00Z" },
    ],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "BUILD");
  assert.equal(diagnostic.code, "BUILD_FAILED");
});

test("resolved public access block does not remain active", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "HEALTH_CHECKING" },
    events: [
      { eventType: "PUBLIC_ACCESS_VERIFIED", metadata: { checkUrl: "https://app.vercel.app" }, createdAt: "2026-09-03T00:02:00Z" },
      { eventType: "PUBLIC_ACCESS_BLOCKED", metadata: { checkUrl: "https://app.vercel.app", httpStatus: 302 }, createdAt: "2026-09-03T00:01:00Z" },
    ],
  }));

  assert.equal(diagnostic.severity, "NONE");
  assert.equal(diagnostic.code, "NO_CURRENT_ISSUE");
});

test("provider quota block is non-retryable and provider rate limit is retryable", () => {
  const quota = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "BUILDING", errorCode: "VERCEL_DAILY_DEPLOYMENT_QUOTA" },
  }));
  const rate = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "BUILDING", errorCode: "VERCEL_RATE_LIMIT" },
  }));

  assert.equal(quota.stage, "BUILD");
  assert.equal(quota.severity, "BLOCKED");
  assert.equal(quota.retryable, false);
  assert.equal(rate.stage, "BUILD");
  assert.equal(rate.retryable, true);
});

test("resource policy block is normalized as policy blocked", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "BUILDING", errorCode: "ENV_VAR_LIMIT_EXCEEDED" },
    events: [{
      eventType: "RESOURCE_POLICY_BLOCKED",
      metadata: { policyTier: "starter", violations: [{ code: "ENV_VAR_LIMIT_EXCEEDED", message: "Too many env vars" }] },
      createdAt: "2026-09-03T00:00:00Z",
    }],
  }));

  assert.equal(diagnostic.severity, "BLOCKED");
  assert.equal(diagnostic.stage, "POLICY");
  assert.equal(diagnostic.code, "ENV_VAR_LIMIT_EXCEEDED");
  assert.equal(diagnostic.evidence.violations[0].code, "ENV_VAR_LIMIT_EXCEEDED");
});

test("live and in-progress deployments without current issues return none", () => {
  const live = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "LIVE", liveUrl: "https://app.vercel.app" },
  }));
  const inProgress = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "PROVISIONING" },
    build: null,
  }));

  assert.equal(live.severity, "NONE");
  assert.equal(live.code, "DEPLOYMENT_LIVE");
  assert.equal(inProgress.severity, "NONE");
  assert.equal(inProgress.code, "NO_CURRENT_ISSUE");
});

test("unknown error code degrades safely", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "SOMETHING_NEW" },
    events: [{ eventType: "NEW_EVENT", metadata: { providerBody: { token: "nope" } }, createdAt: "2026-09-03T00:00:00Z" }],
  }));

  assert.equal(diagnostic.severity, "FAILED");
  assert.equal(diagnostic.stage, "UNKNOWN");
  assert.equal(diagnostic.code, "SOMETHING_NEW");
  assert.equal(JSON.stringify(diagnostic).includes("nope"), false);
});

test("diagnostic evidence strips secret and provider body fields", () => {
  const diagnostic = normalizeDeploymentDiagnostic(baseContext({
    deployment: { status: "FAILED", errorCode: "BUILD_FAILED" },
    events: [{
      eventType: "BUILD_FAILED",
      metadata: {
        providerDeploymentId: "dpl_1",
        secretValue: "super-secret",
        VERCEL_TOKEN: "token-value",
        providerBody: { raw: "provider dump" },
      },
      createdAt: "2026-09-03T00:00:00Z",
    }],
  }));

  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("token-value"), false);
  assert.equal(serialized.includes("provider dump"), false);
});
