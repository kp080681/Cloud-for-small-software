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

function safeSha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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

async function probeSummary(db) {
  const result = await db.query(
    `SELECT value
       FROM ssc_recovery_probe
      ORDER BY id ASC`,
  );
  const values = result.rows.map((row) => row.value);
  return {
    rowCount: values.length,
    digest: safeSha256(values.join("\n")),
  };
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
      await db.query(`CREATE TABLE IF NOT EXISTS ssc_recovery_probe (id integer PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await db.query(`TRUNCATE ssc_recovery_probe`);
      await db.query(`INSERT INTO ssc_recovery_probe (id, value) VALUES (1,'alpha'),(2,'bravo'),(3,'charlie')`);
      const original = await probeSummary(db);
      const lsnResult = await db.query(`SELECT pg_current_wal_lsn()::text AS lsn`);
      const recoveryLsn = lsnResult.rows[0].lsn;

      await db.query(`DELETE FROM ssc_recovery_probe WHERE id=2`);
      await db.query(`INSERT INTO ssc_recovery_probe (id, value) VALUES (4,'delta-after-recovery-point')`);
      const mutated = await probeSummary(db);
      const destructiveTestMutationConfirmed = mutated.digest !== original.digest && mutated.rowCount !== original.rowCount;
      if (!destructiveTestMutationConfirmed) throw new Error("Destructive test mutation did not change probe data");

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
        recovered = await probeSummary(recoveredDb);
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
        destructiveTestMutationConfirmed,
        mutatedRowCount: mutated.rowCount,
        mutatedDigest: mutated.digest,
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
