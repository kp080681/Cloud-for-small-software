import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  DatabaseMode,
  ManagedDatabaseStatus,
  claimManagedDatabaseCreate,
  ensureManagedDatabaseIntent,
  markManagedDatabaseReconciliationRequired,
  persistManagedDatabaseReady,
  recordDatabaseEvent,
} from "../src/managed-database-lifecycle.mjs";
import {
  createNeonProject,
  getNeonConnectionUri,
  listNeonProjectsByName,
  normalizeNeonProjectResource,
} from "../src/neon-managed-postgres.mjs";

const { Client } = pg;

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}

export const provisionDatabase = task({
  id: "ssc-control-plane-provision-database",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => withDb(async (db) => {
    const result = await db.query(
      `SELECT d.id, d.workspace_id, d.app_id, d.status,
              a.database_required, a.database_mode
         FROM deployments d
         JOIN apps a ON a.id=d.app_id
        WHERE d.id=$1`,
      [payload.deploymentId],
    );
    if (result.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
    const deployment = result.rows[0];
    if (!["PROVISIONING", "BUILDING"].includes(deployment.status)) {
      throw new Error(`Database provisioning cannot run from status ${deployment.status}`);
    }
    if (deployment.database_mode !== DatabaseMode.SSC_MANAGED) {
      return {
        result: "NODE_15R_12A_DATABASE_PROVISIONING_SKIPPED",
        deploymentId: payload.deploymentId,
        databaseMode: deployment.database_mode,
        databaseRequired: deployment.database_required,
      };
    }

    const intent = await ensureManagedDatabaseIntent(db, deployment);
    if (intent.action === "blocked") {
      return {
        result: "NODE_15R_12A_MANAGED_DATABASE_LIMIT_REACHED",
        deploymentId: payload.deploymentId,
        databaseMode: DatabaseMode.SSC_MANAGED,
        policy: intent.decision,
      };
    }

    let row = intent.row;
    if (row.status === ManagedDatabaseStatus.READY && row.connection_secret_id) {
      return {
        result: "NODE_15R_12A_MANAGED_DATABASE_READY",
        deploymentId: payload.deploymentId,
        provider: row.provider,
        providerProjectId: row.provider_project_id,
        providerProjectName: row.provider_project_name,
        databaseMode: DatabaseMode.SSC_MANAGED,
        reconciled: true,
      };
    }

    const candidates = await listNeonProjectsByName(intent.expectedName);
    if (candidates.length > 1) {
      await markManagedDatabaseReconciliationRequired(db, {
        deployment,
        row,
        reason: "AMBIGUOUS_PROVIDER_DATABASES",
        evidence: { providerProjectName: intent.expectedName, matchingProjectCount: candidates.length },
      });
      return {
        result: "NODE_15R_12A_DATABASE_RECONCILIATION_AMBIGUOUS",
        deploymentId: payload.deploymentId,
        provider: "neon",
        providerProjectName: intent.expectedName,
        matchingProjectCount: candidates.length,
      };
    }

    let providerResource;
    let created = false;
    if (candidates.length === 1) {
      providerResource = normalizeNeonProjectResource(candidates[0]);
    } else {
      const claimed = await claimManagedDatabaseCreate(db, row);
      if (!claimed) {
        return {
          result: "NODE_15R_12A_DATABASE_CREATE_IN_FLIGHT",
          deploymentId: payload.deploymentId,
          provider: "neon",
          providerProjectName: intent.expectedName,
          databaseMode: DatabaseMode.SSC_MANAGED,
        };
      }
      try {
        providerResource = normalizeNeonProjectResource(await createNeonProject({
          workspaceId: deployment.workspace_id,
          appId: deployment.app_id,
        }));
        created = true;
      } catch (error: any) {
        await markManagedDatabaseReconciliationRequired(db, {
          deployment,
          row: claimed,
          reason: "PROVIDER_CREATE_RESPONSE_UNAVAILABLE",
          evidence: { providerProjectName: intent.expectedName, providerStatus: error?.status ?? null },
        });
        return {
          result: "NODE_15R_12A_DATABASE_RECONCILIATION_REQUIRED",
          deploymentId: payload.deploymentId,
          provider: "neon",
          providerProjectName: intent.expectedName,
        };
      }
    }

    const uriResponse = await getNeonConnectionUri(providerResource);
    const connectionUri = uriResponse?.uri ?? uriResponse?.connection_uri ?? uriResponse?.connectionUri;
    if (!connectionUri) throw new Error("Neon connection URI response did not include a URI");

    await db.query("BEGIN");
    try {
      const ready = await persistManagedDatabaseReady(db, { deployment, row, resource: providerResource, connectionUri });
      await db.query("COMMIT");
      return {
        result: "NODE_15R_12A_MANAGED_DATABASE_READY",
        deploymentId: payload.deploymentId,
        provider: "neon",
        providerProjectId: ready.provider_project_id,
        providerProjectName: ready.provider_project_name,
        databaseMode: DatabaseMode.SSC_MANAGED,
        created,
        reconciled: !created,
        databaseUrlEncrypted: true,
        plaintextPrinted: false,
        plaintextPersistedOutsideEncryptedSecret: false,
      };
    } catch (error) {
      await db.query("ROLLBACK");
      await recordDatabaseEvent(db, deployment, "DATABASE_PROVISIONING_FAILED", "Managed PostgreSQL provisioning failed after provider resource was observed", {
        provider: "neon",
        providerProjectId: providerResource.providerProjectId,
        providerProjectName: providerResource.providerProjectName,
        plaintextPrinted: false,
      });
      throw error;
    }
  }),
});
