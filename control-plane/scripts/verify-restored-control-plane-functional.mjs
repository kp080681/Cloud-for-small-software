import { createHash } from "node:crypto";
import pg from "pg";
import { loadDeploymentDiagnosticContext } from "../src/deployment-diagnostic-context.mjs";
import { normalizeDeploymentDiagnostic } from "../src/deployment-diagnostics.mjs";
import { normalizeDeploymentTimeline } from "../src/deployment-timeline.mjs";
import { secretRecoveryMode } from "../src/recovery-safety.mjs";
import { decryptAppSecret } from "../src/secret-store.mjs";

const { Client } = pg;

const DEALUP_DEPLOYMENT_ID = "fc494742-a56c-4050-8df0-0a667f32efa7";
const DEALUP_EXPECTED_COMMIT_SHA = "f6afa1c1312de8d6da8d49fdab22148ae5701199";
const FAILED_HEALTH_DEPLOYMENT_ID = "06581b97-14f7-43f4-8254-947d2235efb9";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function assertTruthy(value, label) {
  if (!value) throw new Error(`${label}: expected truthy value`);
}

async function connectRestoredDb() {
  const db = new Client({
    connectionString: requireEnv("RESTORE_DATABASE_URL"),
  });
  await db.connect();
  await db.query("SET search_path TO public");
  return db;
}

function diagnosticSummary(diagnostic) {
  return {
    severity: diagnostic.severity,
    stage: diagnostic.stage,
    code: diagnostic.code,
    retryable: diagnostic.retryable,
  };
}

function timelineSummary(timeline) {
  return {
    deploymentId: timeline.deploymentId,
    currentStatus: timeline.currentStatus,
    sourceCommitSha: timeline.source.commitSha,
    eventCount: timeline.summary.eventCount,
    reachedProviderBuild: timeline.summary.reachedProviderBuild,
    reachedHealthCheck: timeline.summary.reachedHealthCheck,
    reachedLive: timeline.summary.reachedLive,
    terminal: timeline.summary.terminal,
  };
}

async function verifyDeployment(db, deploymentId) {
  const context = await loadDeploymentDiagnosticContext(db, deploymentId, { eventLimit: null });
  const diagnostic = normalizeDeploymentDiagnostic(context);
  const timeline = normalizeDeploymentTimeline(context, diagnostic);
  return { context, diagnostic, timeline };
}

async function secretRecoverySummary(db) {
  const testSecretName = process.env.CONTROL_PLANE_RESTORE_TEST_SECRET_NAME;
  const expectedDigest = process.env.CONTROL_PLANE_RESTORE_TEST_SECRET_SHA256;
  const initialMode = secretRecoveryMode({ testSecretName, expectedDigest });
  if (!initialMode.requiresDecrypt) {
    return {
      status: initialMode.status,
      reason: !testSecretName
        ? "No deterministic test secret name provided"
        : "Expected digest or clearly marked backup/restore test secret was not provided",
      decryptOperationSucceeded: false,
      plaintextPrinted: false,
    };
  }

  const result = await db.query(
    `SELECT id, app_id, name, kms_key_id, encryption_context,
            ciphertext IS NOT NULL AS has_ciphertext,
            encrypted_data_key IS NOT NULL AS has_encrypted_data_key,
            iv IS NOT NULL AS has_iv,
            auth_tag IS NOT NULL AS has_auth_tag
       FROM public.encrypted_secrets
      WHERE name = $1
      ORDER BY created_at ASC`,
    [testSecretName],
  );

  if (result.rowCount !== 1) {
    return {
      status: "METADATA_ONLY",
      reason: `Expected exactly one deterministic test secret row, found ${result.rowCount}`,
      matchingRows: result.rowCount,
      decryptOperationSucceeded: false,
      plaintextPrinted: false,
    };
  }

  const row = result.rows[0];
  const metadataComplete = Boolean(
    row.has_ciphertext &&
    row.has_encrypted_data_key &&
    row.has_iv &&
    row.has_auth_tag &&
    row.kms_key_id &&
    row.encryption_context,
  );

  const selectedMode = secretRecoveryMode({
    testSecretName,
    expectedDigest,
    matchingRows: result.rowCount,
  });
  if (!selectedMode.requiresDecrypt) {
    return {
      status: selectedMode.status,
      reason: result.rowCount !== 1
        ? `Expected exactly one deterministic test secret row, found ${result.rowCount}`
        : "Deterministic test secret row exists, but no expected digest was provided",
      secretId: row.id,
      metadataComplete,
      decryptOperationSucceeded: false,
      plaintextPrinted: false,
    };
  }

  const plaintext = await decryptAppSecret(db, { appId: row.app_id, name: row.name });
  const digestMatches = createHash("sha256").update(plaintext).digest("hex") === expectedDigest.toLowerCase();
  const finalMode = secretRecoveryMode({
    testSecretName,
    expectedDigest,
    matchingRows: result.rowCount,
    decryptOperationSucceeded: true,
    digestMatches,
  });
  if (!digestMatches) process.exitCode = 1;

  return {
    status: finalMode.status,
    secretId: row.id,
    metadataComplete,
    decryptOperationSucceeded: true,
    digestMatches,
    plaintextPrinted: false,
  };
}

const db = await connectRestoredDb();

try {
  const restoredDealUp = await verifyDeployment(db, DEALUP_DEPLOYMENT_ID);
  const restoredFailed = await verifyDeployment(db, FAILED_HEALTH_DEPLOYMENT_ID);

  assertEqual(restoredDealUp.context.deployment.status, "LIVE", "DealUp deployment status");
  assertEqual(restoredDealUp.context.deployment.sourceCommitSha, DEALUP_EXPECTED_COMMIT_SHA, "DealUp source commit");
  assertEqual(restoredDealUp.diagnostic.severity, "NONE", "DealUp diagnostic severity");
  assertEqual(restoredDealUp.diagnostic.code, "DEPLOYMENT_LIVE", "DealUp diagnostic code");

  assertTruthy(restoredDealUp.timeline.summary.eventCount > 0, "DealUp timeline event count");
  assertEqual(restoredDealUp.timeline.summary.reachedProviderBuild, true, "DealUp reached provider build");
  assertEqual(restoredDealUp.timeline.summary.reachedHealthCheck, true, "DealUp reached health check");
  assertEqual(restoredDealUp.timeline.summary.reachedLive, true, "DealUp reached live");
  assertEqual(restoredDealUp.timeline.summary.terminal, true, "DealUp terminal");
  assertEqual(restoredDealUp.timeline.currentStatus, "LIVE", "DealUp timeline current status");

  assertEqual(restoredFailed.context.deployment.status, "FAILED", "Failed-health deployment status");
  assertEqual(restoredFailed.diagnostic.severity, "FAILED", "Failed-health diagnostic severity");
  assertEqual(restoredFailed.diagnostic.stage, "HEALTH", "Failed-health diagnostic stage");
  assertEqual(restoredFailed.diagnostic.code, "HEALTH_CHECK_FAILED", "Failed-health diagnostic code");
  assertTruthy(restoredFailed.timeline.summary.eventCount > 0, "Failed-health historical event count");

  const secretRecovery = await secretRecoverySummary(db);

  console.log(JSON.stringify({
    result: "RESTORED_CONTROL_PLANE_FUNCTIONAL_VERIFIED",
    restoredDealUpDiagnostic: diagnosticSummary(restoredDealUp.diagnostic),
    restoredFailedDiagnostic: diagnosticSummary(restoredFailed.diagnostic),
    restoredDealUpTimelineSummary: timelineSummary(restoredDealUp.timeline),
    restoredFailedTimelineSummary: timelineSummary(restoredFailed.timeline),
    secretRecovery,
    providerCallsExecuted: false,
    triggerCallsExecuted: false,
    databaseWritesExecuted: false,
    plaintextSecretsPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
