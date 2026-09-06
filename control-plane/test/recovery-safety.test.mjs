import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertBackupDigestMatches,
  assertDisposableRestoreTarget,
  publicTableIdentifier,
  REQUIRED_CONTROL_PLANE_TABLES,
  restoreVerificationFailures,
  safeDatabaseIdentityText,
  sameDatabaseTarget,
  secretRecoveryMode,
} from "../src/recovery-safety.mjs";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function pgUrl({ host = "ep-test.us-east-1.aws.neon.tech", db = "ssc", user = "owner", password = "secret", query = "" } = {}) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${encodeURIComponent(db)}${query}`;
}

test("restore guard refuses same database with textually different query parameters", () => {
  const source = pgUrl({ query: "?sslmode=require&application_name=source" });
  const restore = pgUrl({ query: "?application_name=restore&sslmode=require" });

  assert.equal(sameDatabaseTarget(source, restore), true);
  assert.throws(
    () => assertDisposableRestoreTarget({
      sourceDatabaseUrl: source,
      restoreDatabaseUrl: restore,
      expectedRestoreTargetIdentity: safeDatabaseIdentityText(restore),
    }),
    /same database target/,
  );
});

test("restore guard refuses pooled and direct Neon hosts for the same database identity", () => {
  const source = pgUrl({ host: "ep-young-sun.us-east-1.aws.neon.tech" });
  const restore = pgUrl({ host: "ep-young-sun-pooler.us-east-1.aws.neon.tech" });

  assert.equal(sameDatabaseTarget(source, restore), true);
  assert.throws(
    () => assertDisposableRestoreTarget({
      sourceDatabaseUrl: source,
      restoreDatabaseUrl: restore,
      expectedRestoreTargetIdentity: safeDatabaseIdentityText(restore),
    }),
    /same database target/,
  );
});

test("restore guard allows a different approved disposable target identity", () => {
  const source = pgUrl({ host: "ep-source.us-east-1.aws.neon.tech" });
  const restore = pgUrl({ host: "ep-disposable.us-east-1.aws.neon.tech", db: "restore" });

  assert.deepEqual(assertDisposableRestoreTarget({
    sourceDatabaseUrl: source,
    restoreDatabaseUrl: restore,
    expectedRestoreTargetIdentity: safeDatabaseIdentityText(restore),
  }), {
    restoreTargetIdentity: "host=ep-disposable.us-east-1.aws.neon.tech;port=5432;database=restore;user=owner",
    sourceCompared: true,
  });
});

test("restore guard refuses missing or mismatched restore target identity", () => {
  const restore = pgUrl();

  assert.throws(
    () => assertDisposableRestoreTarget({ restoreDatabaseUrl: restore, expectedRestoreTargetIdentity: "" }),
    /Missing CONTROL_PLANE_RESTORE_TARGET_IDENTITY/,
  );
  assert.throws(
    () => assertDisposableRestoreTarget({
      restoreDatabaseUrl: restore,
      expectedRestoreTargetIdentity: "host=wrong;port=5432;database=ssc;user=owner",
    }),
    /does not match CONTROL_PLANE_RESTORE_TARGET_IDENTITY/,
  );
});

test("backup digest verification requires an expected digest and fails closed on mismatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-recovery-safety-"));
  const backupFile = path.join(dir, "backup.dump");
  fs.writeFileSync(backupFile, "disposable backup bytes");
  const digest = createHash("sha256").update("disposable backup bytes").digest("hex");

  assert.equal(assertBackupDigestMatches({ backupFile, expectedSha256: digest.toUpperCase() }), digest);
  assert.throws(
    () => assertBackupDigestMatches({ backupFile, expectedSha256: "" }),
    /Missing CONTROL_PLANE_BACKUP_SHA256/,
  );
  assert.throws(
    () => assertBackupDigestMatches({ backupFile, expectedSha256: "0".repeat(64) }),
    /backup SHA-256 does not match/,
  );
});

test("required restore verification failures force nonzero verifier semantics", () => {
  assert.deepEqual(restoreVerificationFailures({
    comparisons: [
      { table: "workspaces", sourceExists: true, restoredExists: true, rowCountMatches: true },
      { table: "deployments", sourceExists: true, restoredExists: false, rowCountMatches: false },
      { table: "deployment_events", sourceExists: true, restoredExists: true, rowCountMatches: false },
    ],
    missingRequiredColumns: [{ table: "apps", column: "workspace_id" }],
    missingRequiredUniqueConstraints: [{ table: "apps", columns: ["workspace_id", "slug"] }],
    secretRecovery: { rowCount: 2, completeMetadataCount: 1 },
  }), [
    "table_missing:deployments",
    "row_count_mismatch:deployment_events",
    "column_missing:apps.workspace_id",
    "unique_constraint_missing:apps(workspace_id,slug)",
    "encrypted_secret_metadata_incomplete",
  ]);
});

test("secret recovery modes are metadata-only unless an explicit test secret digest can be checked", () => {
  assert.deepEqual(secretRecoveryMode({}), { status: "METADATA_ONLY", requiresDecrypt: false });
  assert.deepEqual(secretRecoveryMode({
    testSecretName: "PRODUCTION_API_KEY",
    expectedDigest: "a".repeat(64),
    matchingRows: 1,
  }), { status: "METADATA_ONLY", requiresDecrypt: false });
  assert.deepEqual(secretRecoveryMode({
    testSecretName: "SSC_BACKUP_TEST_SECRET",
    expectedDigest: "a".repeat(64),
    matchingRows: 1,
  }), { status: "DECRYPT_REQUIRED", requiresDecrypt: true });
  assert.deepEqual(secretRecoveryMode({
    testSecretName: "SSC_BACKUP_TEST_SECRET",
    expectedDigest: "a".repeat(64),
    matchingRows: 1,
    decryptOperationSucceeded: true,
    digestMatches: false,
  }), { status: "DIGEST_MISMATCH", requiresDecrypt: false });
});

test("recovery scripts use guarded restore and valid restored-secret decrypt call shape", () => {
  const restore = readControlPlaneFile("scripts/restore-control-plane-db-disposable.mjs");
  const functional = readControlPlaneFile("scripts/verify-restored-control-plane-functional.mjs");

  assert.match(restore, /assertDisposableRestoreTarget/);
  assert.match(restore, /assertBackupDigestMatches/);
  assert.match(restore, /CONTROL_PLANE_RESTORE_TARGET_IDENTITY/);
  assert.match(restore, /CONTROL_PLANE_BACKUP_SHA256/);

  assert.match(functional, /decryptAppSecret\(db, \{ appId: row\.app_id, name: row\.name \}\)/);
  assert.doesNotMatch(functional, /decryptAppSecret\(db, row\.app_id, row\.name\)/);
  assert.match(functional, /plaintextPrinted: false/);
});

test("restore verification covers current control-plane schema and safe public identifiers", () => {
  assert.ok(REQUIRED_CONTROL_PLANE_TABLES.includes("app_env_requirements"));
  assert.ok(!REQUIRED_CONTROL_PLANE_TABLES.includes("redeployments"));
  assert.equal(publicTableIdentifier("deployment_events"), "public.deployment_events");
  assert.throws(() => publicTableIdentifier("deployment_events;drop table apps"), /Unexpected table identifier|Unsafe table identifier/);
});

test("recovery verification scripts do not call providers or Trigger tasks", () => {
  const restore = readControlPlaneFile("scripts/restore-control-plane-db-disposable.mjs");
  const verifier = readControlPlaneFile("scripts/verify-control-plane-restore.mjs");
  const functional = readControlPlaneFile("scripts/verify-restored-control-plane-functional.mjs");
  const combined = `${restore}\n${verifier}\n${functional}`;

  assert.doesNotMatch(combined, /@trigger\.dev\/sdk/);
  assert.doesNotMatch(combined, /fetch\(/);
  assert.doesNotMatch(combined, /VERCEL_TOKEN/);
  assert.doesNotMatch(combined, /deleteVercelProject|createVercelDeployment|cancelVercelDeployment/);
});
