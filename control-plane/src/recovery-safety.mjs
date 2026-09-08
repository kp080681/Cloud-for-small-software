import { createHash } from "node:crypto";
import fs from "node:fs";

export const REQUIRED_CONTROL_PLANE_TABLES = Object.freeze([
  "workspaces",
  "customer_identities",
  "customer_workspace_memberships",
  "github_installations",
  "workspace_github_installations",
  "github_repositories",
  "apps",
  "deployments",
  "deployment_events",
  "encrypted_secrets",
  "app_databases",
  "deployment_build_inputs",
  "app_runtimes",
  "app_secret_bindings",
  "deployment_secret_applications",
  "app_env_requirements",
  "deployment_builds",
  "deployment_health_checks",
  "deployment_logs",
  "app_deletions",
  "app_resource_policies",
  "deployment_env_detection_snapshots",
  "deployment_env_requirement_detections",
  "deployment_provider_operations",
  "workspace_resource_policies",
]);

export const REQUIRED_CONTROL_PLANE_COLUMNS = Object.freeze({
  apps: ["id", "workspace_id", "repository_id", "slug", "database_mode", "deleted_at"],
  deployments: ["id", "workspace_id", "app_id", "source_commit_sha", "status", "error_code", "live_url"],
  deployment_events: ["deployment_id", "event_type", "metadata", "created_at"],
  encrypted_secrets: [
    "workspace_id",
    "app_id",
    "name",
    "ciphertext",
    "encrypted_data_key",
    "iv",
    "auth_tag",
    "kms_key_id",
    "encryption_context",
  ],
  app_runtimes: ["workspace_id", "app_id", "provider", "provider_project_id", "reconciliation_key"],
  app_databases: ["workspace_id", "app_id", "database_mode", "provider", "provider_project_id", "reconciliation_key", "status"],
  deployment_build_inputs: ["deployment_id", "repository_full_name", "commit_sha", "git_tree_sha", "root_directory"],
  deployment_builds: ["deployment_id", "provider", "provider_deployment_id", "source_commit_sha", "status"],
  deployment_provider_operations: ["deployment_id", "operation_type", "provider", "idempotency_key", "status"],
  workspace_resource_policies: ["workspace_id", "max_active_apps", "max_active_deployments", "max_active_deployments_per_app", "max_concurrent_provider_operations", "max_managed_databases"],
});

export const REQUIRED_CONTROL_PLANE_UNIQUE_CONSTRAINTS = Object.freeze([
  { table: "customer_identities", columns: ["provider", "provider_account_id"] },
  { table: "customer_workspace_memberships", columns: ["customer_identity_id", "workspace_id"] },
  { table: "github_installations", columns: ["github_installation_id"] },
  { table: "workspace_github_installations", columns: ["workspace_id", "github_installation_id"] },
  { table: "github_repositories", columns: ["workspace_id", "github_installation_id", "github_repository_id"] },
  { table: "github_repositories", columns: ["workspace_id", "full_name"] },
  { table: "apps", columns: ["workspace_id", "slug"] },
  { table: "deployments", columns: ["deployment_key"] },
  { table: "encrypted_secrets", columns: ["app_id", "name"] },
  { table: "app_runtimes", columns: ["app_id"] },
  { table: "app_runtimes", columns: ["reconciliation_key"] },
  { table: "app_runtimes", columns: ["provider", "provider_project_id"] },
  { table: "app_databases", columns: ["app_id"] },
  { table: "app_databases", columns: ["reconciliation_key"] },
  { table: "app_databases", columns: ["provider", "provider_project_id"] },
  { table: "deployment_build_inputs", columns: ["deployment_id"] },
  { table: "app_secret_bindings", columns: ["app_id", "env_key", "target_environment"] },
  { table: "deployment_builds", columns: ["deployment_id"] },
  { table: "deployment_builds", columns: ["provider", "provider_deployment_id"] },
  { table: "deployment_health_checks", columns: ["deployment_id", "attempt_number"] },
  { table: "app_deletions", columns: ["app_id"] },
  { table: "app_deletions", columns: ["deletion_key"] },
  { table: "app_resource_policies", columns: ["app_id"] },
  { table: "deployment_env_detection_snapshots", columns: ["deployment_id"] },
  { table: "deployment_env_requirement_detections", columns: ["deployment_id", "env_key"] },
  { table: "deployment_provider_operations", columns: ["idempotency_key"] },
  { table: "deployment_provider_operations", columns: ["deployment_id", "operation_type"] },
  { table: "workspace_resource_policies", columns: ["workspace_id"] },
]);

export function publicTableIdentifier(table) {
  if (!REQUIRED_CONTROL_PLANE_TABLES.includes(table) && table !== "encrypted_secrets") {
    throw new Error(`Unexpected table identifier: ${table}`);
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Unsafe table identifier: ${table}`);
  }
  return `public.${table}`;
}

export function safeDatabaseIdentityFromUrl(connectionString) {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database || !url.username) {
    throw new Error("Database URL must include hostname, database, and username");
  }

  return {
    host: normalizeHostForComparison(url.hostname),
    port: url.port || "5432",
    database,
    user: decodeURIComponent(url.username),
  };
}

export function safeDatabaseIdentityText(connectionString) {
  const identity = safeDatabaseIdentityFromUrl(connectionString);
  return `host=${identity.host};port=${identity.port};database=${identity.database};user=${identity.user}`;
}

export function sameDatabaseTarget(leftConnectionString, rightConnectionString) {
  const left = safeDatabaseIdentityFromUrl(leftConnectionString);
  const right = safeDatabaseIdentityFromUrl(rightConnectionString);
  return left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.user === right.user;
}

export function assertDisposableRestoreTarget({
  sourceDatabaseUrl,
  restoreDatabaseUrl,
  expectedRestoreTargetIdentity,
}) {
  if (!restoreDatabaseUrl) throw new Error("Missing restore database URL");
  if (!expectedRestoreTargetIdentity) {
    throw new Error("Missing CONTROL_PLANE_RESTORE_TARGET_IDENTITY for disposable restore target");
  }

  const restoreIdentity = safeDatabaseIdentityText(restoreDatabaseUrl);
  if (restoreIdentity !== expectedRestoreTargetIdentity) {
    throw new Error("Refusing restore because RESTORE_DATABASE_URL does not match CONTROL_PLANE_RESTORE_TARGET_IDENTITY");
  }

  if (sourceDatabaseUrl && sameDatabaseTarget(sourceDatabaseUrl, restoreDatabaseUrl)) {
    throw new Error("Refusing restore because RESTORE_DATABASE_URL identifies the same database target as DATABASE_URL");
  }

  return {
    restoreTargetIdentity: restoreIdentity,
    sourceCompared: Boolean(sourceDatabaseUrl),
  };
}

export function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function assertBackupDigestMatches({ backupFile, expectedSha256 }) {
  if (!expectedSha256) throw new Error("Missing CONTROL_PLANE_BACKUP_SHA256");
  if (!/^[0-9a-fA-F]{64}$/.test(expectedSha256)) {
    throw new Error("CONTROL_PLANE_BACKUP_SHA256 must be a SHA-256 hex digest");
  }

  const actualSha256 = sha256File(backupFile);
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("Refusing restore because backup SHA-256 does not match CONTROL_PLANE_BACKUP_SHA256");
  }

  return actualSha256;
}

export function restoreVerificationFailures({
  comparisons = [],
  missingRequiredColumns = [],
  missingRequiredUniqueConstraints = [],
  secretRecovery = null,
}) {
  const failures = [];
  for (const comparison of comparisons) {
    if (!comparison.sourceExists || !comparison.restoredExists) {
      failures.push(`table_missing:${comparison.table}`);
    } else if (!comparison.rowCountMatches) {
      failures.push(`row_count_mismatch:${comparison.table}`);
    }
  }
  for (const item of missingRequiredColumns) {
    failures.push(`column_missing:${item.table}.${item.column}`);
  }
  for (const item of missingRequiredUniqueConstraints) {
    failures.push(`unique_constraint_missing:${item.table}(${item.columns.join(",")})`);
  }
  if (secretRecovery && secretRecovery.rowCount !== secretRecovery.completeMetadataCount) {
    failures.push("encrypted_secret_metadata_incomplete");
  }
  return failures;
}

export function secretRecoveryMode({
  testSecretName,
  expectedDigest,
  matchingRows = 0,
  decryptOperationSucceeded = false,
  digestMatches = null,
}) {
  if (!testSecretName) {
    return { status: "METADATA_ONLY", requiresDecrypt: false };
  }
  if (!expectedDigest) {
    return { status: "METADATA_ONLY", requiresDecrypt: false };
  }
  if (!/^[A-Z0-9_]*(BACKUP|RESTORE|RECOVERY)_TEST[A-Z0-9_]*$/.test(testSecretName)) {
    return { status: "METADATA_ONLY", requiresDecrypt: false };
  }
  if (matchingRows !== 1) {
    return { status: "METADATA_ONLY", requiresDecrypt: false };
  }
  if (!decryptOperationSucceeded) {
    return { status: "DECRYPT_REQUIRED", requiresDecrypt: true };
  }
  return {
    status: digestMatches ? "VERIFIED" : "DIGEST_MISMATCH",
    requiresDecrypt: false,
  };
}

function normalizeHostForComparison(hostname) {
  const lower = hostname.toLowerCase();
  const labels = lower.split(".");
  if (labels[0]?.endsWith("-pooler")) {
    labels[0] = labels[0].slice(0, -"-pooler".length);
  }
  return labels.join(".");
}
