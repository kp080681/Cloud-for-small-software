import crypto from "node:crypto";
import pg from "pg";
import {
  getNeonConnectionUri,
  createNeonProject,
  deleteNeonProject,
  normalizeNeonProjectResource,
  operationIdsFromNeonResponse,
  restoreNeonBranch,
  waitForNeonOperations,
} from "../src/neon-managed-postgres.mjs";
import {
  DatabaseMode,
  ensureTlsConnectionString,
  isSscManagedDatabaseName,
  sscManagedDatabaseName,
} from "../src/managed-database-lifecycle.mjs";
import {
  assertProbeMutationChanged,
  initializeProbeData,
  mutateProbeData,
  normalizeConnectionIdentity,
  readProbeSummary,
} from "../src/managed-database-recovery-probe.mjs";

const { Client } = pg;
const REQUIRED_CONFIRMATION = "CREATE_DISPOSABLE_NEON_RECOVERY_DRILL";
const REQUIRED_CLEANUP_CONFIRMATION = "DELETE_DISPOSABLE_NEON_RECOVERY_DRILL_RESOURCE";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function randomUuid() {
  return crypto.randomUUID();
}

function redactHost(connectionUri) {
  try {
    const host = new URL(connectionUri).hostname;
    const parts = host.split(".");
    return parts.slice(Math.max(0, parts.length - 3)).join(".");
  } catch {
    return null;
  }
}

async function connect(connectionUri) {
  const db = new Client({ connectionString: ensureTlsConnectionString(connectionUri) });
  await db.connect();
  return db;
}

async function waitFromResponse(projectId, response) {
  const operationIds = operationIdsFromNeonResponse(response);
  if (!operationIds.length) return [];
  return waitForNeonOperations({ projectId, operationIds });
}

async function cleanup() {
  if (requireEnv("SSC_MANAGED_DB_RECOVERY_DRILL_CLEANUP_CONFIRM") !== REQUIRED_CLEANUP_CONFIRMATION) {
    throw new Error(`Refusing cleanup without SSC_MANAGED_DB_RECOVERY_DRILL_CLEANUP_CONFIRM=${REQUIRED_CLEANUP_CONFIRMATION}`);
  }
  const projectId = requireEnv("SSC_MANAGED_DB_RECOVERY_DRILL_PROJECT_ID");
  const result = await deleteNeonProject(projectId);
  console.log(JSON.stringify({
    result: "SSC_MANAGED_DATABASE_RECOVERY_DRILL_CLEANUP",
    provider: "neon",
    providerProjectId: projectId,
    deleted: result.deleted,
    notFound: result.notFound,
    plaintextDatabaseCredentialsPrinted: false,
  }, null, 2));
}

async function runDrill() {
  if (requireEnv("SSC_MANAGED_DB_RECOVERY_DRILL_CONFIRM") !== REQUIRED_CONFIRMATION) {
    throw new Error(`Refusing drill without SSC_MANAGED_DB_RECOVERY_DRILL_CONFIRM=${REQUIRED_CONFIRMATION}`);
  }

  const workspaceId = process.env.SSC_MANAGED_DB_RECOVERY_DRILL_WORKSPACE_ID?.trim() || randomUuid();
  const appId = process.env.SSC_MANAGED_DB_RECOVERY_DRILL_APP_ID?.trim() || randomUuid();
  const expectedName = sscManagedDatabaseName({ workspaceId, appId });
  if (!isSscManagedDatabaseName(expectedName)) throw new Error("Generated disposable database name is not SSC-managed");

  const startedAt = Date.now();
  let resource = null;
  let connectionUri = null;
  const cleanupActions = [];

  try {
    const createResponse = await createNeonProject({ workspaceId, appId });
    resource = normalizeNeonProjectResource(createResponse);
    if (resource.providerProjectName !== expectedName) {
      throw new Error("Disposable Neon project name did not match expected SSC identity");
    }
    await waitFromResponse(resource.providerProjectId, createResponse);
    const databaseProvisionDurationMs = Date.now() - startedAt;

    cleanupActions.push({
      action: "delete_neon_project",
      providerProjectId: resource.providerProjectId,
      command: `$env:SSC_MANAGED_DB_RECOVERY_DRILL_CLEANUP_CONFIRM="${REQUIRED_CLEANUP_CONFIRMATION}"; $env:SSC_MANAGED_DB_RECOVERY_DRILL_PROJECT_ID="${resource.providerProjectId}"; node .\\scripts\\run-managed-database-recovery-drill.mjs --cleanup`,
    });

    const uriResponse = await getNeonConnectionUri(resource);
    connectionUri = uriResponse?.uri ?? uriResponse?.connection_uri ?? uriResponse?.connectionUri;
    if (!connectionUri) throw new Error("Neon connection URI response did not include a URI");
    const safeConnectionUri = ensureTlsConnectionString(connectionUri);

    let db = await connect(safeConnectionUri);
    try {
      const original = await initializeProbeData(db);
      const lsnResult = await db.query(`SELECT pg_current_wal_lsn()::text AS lsn`);
      const recoveryLsn = lsnResult.rows[0].lsn;
      const mutationDbIdentity = normalizeConnectionIdentity(safeConnectionUri);
      const mutated = await mutateProbeData(db);
      const postMutationVerifyDbIdentity = normalizeConnectionIdentity(safeConnectionUri);
      const mutationCheck = assertProbeMutationChanged({
        original,
        mutated,
        mutationDbIdentity,
        verificationDbIdentity: postMutationVerifyDbIdentity,
      });

      await db.end();
      db = null;

      const recoveryStartedAt = Date.now();
      const restoreResponse = await restoreNeonBranch({
        projectId: resource.providerProjectId,
        branchId: resource.providerBranchId,
        sourceBranchId: resource.providerBranchId,
        sourceLsn: recoveryLsn,
        preserveUnderName: `ssc-recovery-drill-mutated-${Date.now()}`,
      });
      await waitFromResponse(resource.providerProjectId, restoreResponse);
      const recoveryOperationDurationMs = Date.now() - recoveryStartedAt;

      const verifyStartedAt = Date.now();
      const recoveredDb = await connect(safeConnectionUri);
      let recovered;
      try {
        recovered = await readProbeSummary(recoveredDb);
      } finally {
        await recoveredDb.end();
      }
      const postRecoveryVerificationDurationMs = Date.now() - verifyStartedAt;

      console.log(JSON.stringify({
        result: "SSC_MANAGED_DATABASE_RECOVERY_DRILL_READY_FOR_EVIDENCE_REVIEW",
        provider: "neon",
        recoveryMechanism: "NEON_BRANCH_RESTORE_TO_LSN",
        restoreTargetModel: "IN_PLACE_BRANCH_RESTORE_WITH_PRESERVED_BACKUP_BRANCH",
        workspaceId,
        appId,
        databaseMode: DatabaseMode.SSC_MANAGED,
        providerProjectId: resource.providerProjectId,
        providerProjectName: resource.providerProjectName,
        providerBranchId: resource.providerBranchId,
        providerEndpointId: resource.providerEndpointId,
        providerDatabaseName: resource.providerDatabaseName,
        providerRoleName: resource.providerRoleName,
        hostSuffix: redactHost(safeConnectionUri),
        originalRowCount: original.rowCount,
        originalDigest: original.digest,
        destructiveTestMutationConfirmed: mutationCheck.mutationChangedState,
        mutatedRowCount: mutated.rowCount,
        mutatedDigest: mutated.digest,
        mutationRowCountChanged: mutationCheck.rowCountChanged,
        mutationDigestChanged: mutationCheck.digestChanged,
        recoveryCompleted: true,
        recoveredRowCount: recovered.rowCount,
        recoveredDigest: recovered.digest,
        rowCountParity: recovered.rowCount === original.rowCount,
        dataDigestParity: recovered.digest === original.digest,
        databaseProvisionDurationMs,
        recoveryOperationDurationMs,
        postRecoveryVerificationDurationMs,
        recoveryRequiresNewDatabaseUrl: false,
        recoveredDatabaseUrlEncrypted: "NOT_APPLICABLE",
        cleanupRequired: true,
        cleanupActions,
        providerCallsExecuted: true,
        providerResourcesMutated: "DISPOSABLE_ONLY",
        productionDatabaseMutated: false,
        plaintextDatabaseCredentialsPrinted: false,
      }, null, 2));
    } finally {
      if (db) await db.end();
    }
  } catch (error) {
    console.error(JSON.stringify({
      result: "SSC_MANAGED_DATABASE_RECOVERY_DRILL_FAILED",
      provider: "neon",
      providerProjectId: resource?.providerProjectId ?? null,
      providerProjectName: resource?.providerProjectName ?? expectedName,
      error: String(error?.message ?? "Managed database recovery drill failed").slice(0, 500),
      cleanupRequired: Boolean(resource?.providerProjectId),
      cleanupActions,
      plaintextDatabaseCredentialsPrinted: false,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    connectionUri = null;
  }
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
} else {
  await runDrill();
}
