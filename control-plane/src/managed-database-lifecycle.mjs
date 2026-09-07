import crypto from "node:crypto";
import { encryptAppSecret } from "./secret-store.mjs";
import { lockWorkspacePolicy, managedDatabaseLimitDecision } from "./workspace-resource-policy.mjs";

export const DatabaseMode = Object.freeze({
  NONE: "NONE",
  EXTERNAL: "EXTERNAL",
  SSC_MANAGED: "SSC_MANAGED",
});

export const ManagedDatabaseStatus = Object.freeze({
  INTENT_RECORDED: "INTENT_RECORDED",
  CREATE_REQUESTED: "CREATE_REQUESTED",
  READY: "READY",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
  FAILED: "FAILED",
  DELETING: "DELETING",
  DELETED: "DELETED",
  DELETE_FAILED: "DELETE_FAILED",
});

export function normalizeDatabaseMode(value, { databaseRequired = false } = {}) {
  if (value === DatabaseMode.NONE || value === DatabaseMode.EXTERNAL || value === DatabaseMode.SSC_MANAGED) return value;
  return databaseRequired ? DatabaseMode.EXTERNAL : DatabaseMode.NONE;
}

export function managedDatabaseReconciliationKey({ workspaceId, appId }) {
  return `database:neon:${workspaceId}:${appId}`;
}

export function sscManagedDatabaseName({ workspaceId, appId }) {
  const appPart = String(appId).replaceAll("-", "").slice(0, 12).toLowerCase();
  const hash = crypto.createHash("sha256").update(`${workspaceId}:${appId}`).digest("hex").slice(0, 12);
  return `ssc-${appPart}-${hash}-db`;
}

export function isSscManagedDatabaseName(name) {
  return /^ssc-[0-9a-f]{12}-[0-9a-f]{12}-db$/.test(String(name ?? ""));
}

export function assertManagedDatabaseBelongsToApp(row, { workspaceId, appId }) {
  if (!row) throw new Error("Managed database record is missing");
  if (row.workspace_id !== workspaceId || row.app_id !== appId) {
    throw new Error("Managed database workspace/app ownership mismatch");
  }
  return true;
}

export function ensureTlsConnectionString(connectionUri) {
  const url = new URL(connectionUri);
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error("Neon connection URI is not PostgreSQL");
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  return url.toString();
}

export function classifyManagedDatabaseResource(resource, controlPlane, options = {}) {
  const providerProjectId = resource?.providerProjectId ?? resource?.id ?? null;
  const providerProjectName = resource?.providerProjectName ?? resource?.name ?? null;
  if (!providerProjectId && !providerProjectName) return { classification: "FOREIGN_IGNORE", reason: "MISSING_PROVIDER_IDENTITY" };
  if (!isSscManagedDatabaseName(providerProjectName)) return { classification: "FOREIGN_IGNORE", reason: "MISSING_SSC_DATABASE_IDENTITY" };
  if (options.ambiguousNames?.has(providerProjectName) || (providerProjectId && options.ambiguousIds?.has(providerProjectId))) {
    return { classification: "AMBIGUOUS", reason: "DUPLICATE_PROVIDER_DATABASE_IDENTITY", providerProjectId, providerProjectName };
  }
  const byId = providerProjectId ? controlPlane.databasesByProviderProjectId?.get(providerProjectId) : null;
  const byName = providerProjectName ? controlPlane.databasesByProviderProjectName?.get(providerProjectName) : null;
  const row = byId ?? byName ?? null;
  if (!row) return { classification: "ORPHAN", reason: "SSC_MANAGED_DATABASE_RECORD_NOT_FOUND", providerProjectId, providerProjectName };
  if (row.databaseMode !== DatabaseMode.SSC_MANAGED && row.database_mode !== DatabaseMode.SSC_MANAGED) {
    return { classification: "AMBIGUOUS", reason: "PROVIDER_DATABASE_BOUND_TO_NON_MANAGED_MODE", providerProjectId, providerProjectName, appId: row.appId ?? row.app_id };
  }
  if (row.status === ManagedDatabaseStatus.DELETED || row.deletedAt || row.deleted_at) {
    return { classification: "ORPHAN", reason: "PROVIDER_DATABASE_EXISTS_AFTER_LOCAL_DELETE", providerProjectId, providerProjectName, appId: row.appId ?? row.app_id };
  }
  if (row.providerProjectId === providerProjectId || row.provider_project_id === providerProjectId) {
    return { classification: "KNOWN", reason: "SSC_MANAGED_DATABASE_BOUND", providerProjectId, providerProjectName, appId: row.appId ?? row.app_id };
  }
  return { classification: "RECOVERABLE", reason: "SSC_MANAGED_DATABASE_NAME_MATCHES_UNBOUND_RECORD", providerProjectId, providerProjectName, appId: row.appId ?? row.app_id };
}

export async function ensureManagedDatabaseIntent(db, deployment) {
  const mode = normalizeDatabaseMode(deployment.database_mode, { databaseRequired: deployment.database_required });
  if (mode !== DatabaseMode.SSC_MANAGED) return { mode, action: "skip" };
  const expectedName = sscManagedDatabaseName({ workspaceId: deployment.workspace_id, appId: deployment.app_id });
  const reconciliationKey = managedDatabaseReconciliationKey({ workspaceId: deployment.workspace_id, appId: deployment.app_id });

  await db.query("BEGIN");
  try {
    const existing = await db.query(
      `SELECT *
         FROM app_databases
        WHERE app_id=$1
        FOR UPDATE`,
      [deployment.app_id],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      assertManagedDatabaseBelongsToApp(row, { workspaceId: deployment.workspace_id, appId: deployment.app_id });
      if (row.database_mode !== DatabaseMode.SSC_MANAGED) throw new Error(`App database is not SSC-managed: ${row.database_mode}`);
      await db.query("COMMIT");
      return { mode, action: "existing", row, expectedName, reconciliationKey };
    }

    const policy = await lockWorkspacePolicy(db, deployment.workspace_id);
    const active = await db.query(
      `SELECT count(*)::int AS count
         FROM app_databases
        WHERE workspace_id=$1
          AND database_mode='SSC_MANAGED'
          AND status <> 'DELETED'`,
      [deployment.workspace_id],
    );
    const decision = managedDatabaseLimitDecision({ managedDatabaseCount: active.rows[0].count, policy });
    if (!decision.allowed) {
      await recordDatabaseEvent(db, deployment, "DATABASE_PROVISIONING_FAILED", "Workspace managed database limit reached", {
        code: decision.code,
        observed: decision.observed,
        limit: decision.limit,
      });
      await db.query("COMMIT");
      return { mode, action: "blocked", decision, expectedName, reconciliationKey };
    }

    const inserted = await db.query(
      `INSERT INTO app_databases
         (workspace_id, app_id, database_mode, provider, provider_project_name, reconciliation_key, status, metadata)
       VALUES ($1,$2,'SSC_MANAGED','neon',$3,$4,'INTENT_RECORDED',$5::jsonb)
       RETURNING *`,
      [deployment.workspace_id, deployment.app_id, expectedName, reconciliationKey, JSON.stringify({ sscManaged: true })],
    );
    await recordDatabaseEvent(db, deployment, "DATABASE_PROVISIONING", "Managed PostgreSQL provisioning intent recorded", {
      provider: "neon",
      providerProjectName: expectedName,
      reconciliationKey,
    });
    await db.query("COMMIT");
    return { mode, action: "created", row: inserted.rows[0], expectedName, reconciliationKey };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function claimManagedDatabaseCreate(db, row) {
  const result = await db.query(
    `UPDATE app_databases
        SET status='CREATE_REQUESTED',
            updated_at=now()
      WHERE id=$1
        AND status IN ('INTENT_RECORDED')
      RETURNING *`,
    [row.id],
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}

export function managedDatabaseProviderResultAttachmentDecision(current) {
  if (!current) return { action: "stale", reason: "DATABASE_ATTACH_TARGET_MISSING" };
  if (current.app_deleted_at) return { action: "stale", reason: "APP_DELETED" };
  if (current.deployment_status === "DELETING" || current.deployment_status === "DELETED") {
    return { action: "stale", reason: "DEPLOYMENT_DELETING_OR_DELETED" };
  }
  if (!["PROVISIONING", "BUILDING"].includes(current.deployment_status)) {
    return { action: "stale", reason: "DEPLOYMENT_STATE_INCOMPATIBLE" };
  }
  if (current.database_mode !== DatabaseMode.SSC_MANAGED) {
    return { action: "stale", reason: "DATABASE_MODE_INCOMPATIBLE" };
  }
  if (![ManagedDatabaseStatus.INTENT_RECORDED, ManagedDatabaseStatus.CREATE_REQUESTED, ManagedDatabaseStatus.RECONCILIATION_REQUIRED].includes(current.database_status)) {
    return { action: "stale", reason: "DATABASE_STATE_INCOMPATIBLE" };
  }
  return { action: "attach" };
}

export async function persistManagedDatabaseReady(db, { deployment, row, resource, connectionUri }) {
  await db.query("BEGIN");
  try {
    const currentResult = await db.query(
      `SELECT d.status AS deployment_status,
              a.deleted_at AS app_deleted_at,
              ad.status AS database_status,
              ad.database_mode AS database_mode
         FROM deployments d
         JOIN apps a ON a.id=d.app_id
         JOIN app_databases ad ON ad.id=$2 AND ad.app_id=d.app_id
        WHERE d.id=$1
        FOR UPDATE OF d,a,ad`,
      [deployment.id, row.id],
    );
    const current = currentResult.rows[0] ?? null;
    const decision = managedDatabaseProviderResultAttachmentDecision(current);
    if (decision.action !== "attach") {
      if (current) {
        if (resource.providerProjectId) {
          await db.query(
            `UPDATE app_databases
                SET provider_project_id=COALESCE(provider_project_id,$1),
                    provider_project_name=COALESCE(provider_project_name,$2),
                    metadata=metadata || $3::jsonb,
                    updated_at=now()
              WHERE id=$4
                AND (provider_project_id IS NULL OR provider_project_id=$1)`,
            [resource.providerProjectId, resource.providerProjectName, JSON.stringify({
              DATABASE_PROVIDER_RESULT_STALE: true,
              staleReason: decision.reason,
              providerProjectId: resource.providerProjectId,
              providerProjectName: resource.providerProjectName,
              providerResourceTraceable: true,
              plaintextPrinted: false,
              plaintextPersistedOutsideEncryptedSecret: false,
            }), row.id],
          );
        }
        await db.query(
          `INSERT INTO deployment_events
             (deployment_id, from_status, to_status, event_type, message, metadata)
           VALUES ($1,$2,$2,'DATABASE_PROVIDER_RESULT_STALE',
                   'Managed PostgreSQL provider result was observed after app/deployment became incompatible', $3::jsonb)`,
          [deployment.id, current.deployment_status, JSON.stringify({
            provider: "neon",
            providerProjectId: resource.providerProjectId,
            providerProjectName: resource.providerProjectName,
            staleReason: decision.reason,
            providerResourceTraceable: Boolean(resource.providerProjectId || resource.providerProjectName),
            plaintextPrinted: false,
            plaintextPersistedOutsideEncryptedSecret: false,
          })],
        );
      }
      await db.query("COMMIT");
      return {
        result: "DATABASE_PROVIDER_RESULT_STALE",
        stale: true,
        staleReason: decision.reason,
        provider_project_id: resource.providerProjectId,
        provider_project_name: resource.providerProjectName,
      };
    }

    const secret = await encryptAppSecret(db, {
      workspaceId: deployment.workspace_id,
      appId: deployment.app_id,
      name: "DATABASE_URL",
      plaintext: ensureTlsConnectionString(connectionUri),
    });
    const binding = await db.query(
      `INSERT INTO app_secret_bindings
         (workspace_id, app_id, secret_id, env_key, target_environment)
       VALUES ($1,$2,$3,'DATABASE_URL','production')
       ON CONFLICT (app_id, env_key, target_environment) DO UPDATE SET
         secret_id = EXCLUDED.secret_id,
         updated_at = now()
       RETURNING id`,
      [deployment.workspace_id, deployment.app_id, secret.id],
    );
    const updated = await db.query(
      `UPDATE app_databases
          SET provider_project_id=$1,
              provider_project_name=$2,
              provider_branch_id=$3,
              provider_endpoint_id=$4,
              provider_database_id=$5,
              provider_database_name=$6,
              provider_role_name=$7,
              connection_secret_id=$8,
              status='READY',
              delete_error_code=NULL,
              delete_error_message=NULL,
              metadata=metadata || $9::jsonb,
              updated_at=now()
        WHERE id=$10
        RETURNING *`,
      [
        resource.providerProjectId,
        resource.providerProjectName,
        resource.providerBranchId,
        resource.providerEndpointId,
        resource.providerDatabaseId,
        resource.providerDatabaseName,
        resource.providerRoleName,
        secret.id,
        JSON.stringify({ sslmode: "require", plaintextPrinted: false, plaintextPersistedOutsideEncryptedSecret: false, bindingId: binding.rows[0]?.id ?? null }),
        row.id,
      ],
    );
    await db.query(
      `UPDATE deployments
          SET database_provider_id=$1,
              updated_at=now()
        WHERE id=$2`,
      [resource.providerProjectId, deployment.id],
    );
    await db.query(
      `INSERT INTO deployment_events
         (deployment_id, from_status, to_status, event_type, message, metadata)
       VALUES ($1,$2,$2,'DATABASE_READY',$3,$4::jsonb)`,
      [deployment.id, current.deployment_status, "Managed PostgreSQL is ready for runtime binding", JSON.stringify({
        provider: "neon",
        providerProjectId: resource.providerProjectId,
        providerProjectName: resource.providerProjectName,
        providerBranchId: resource.providerBranchId,
        providerEndpointId: resource.providerEndpointId,
        providerDatabaseName: resource.providerDatabaseName,
        providerRoleName: resource.providerRoleName,
        secretName: "DATABASE_URL",
        plaintextPrinted: false,
        plaintextPersistedOutsideEncryptedSecret: false,
      })],
    );
    await db.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function markManagedDatabaseReconciliationRequired(db, { deployment, row, reason, evidence = {} }) {
  await db.query(
    `UPDATE app_databases
        SET status='RECONCILIATION_REQUIRED',
            metadata=metadata || $1::jsonb,
            updated_at=now()
      WHERE id=$2`,
    [JSON.stringify({ reconciliationRequiredReason: reason, ...evidence }), row.id],
  );
  await recordDatabaseEvent(db, deployment, "DATABASE_RECONCILIATION_REQUIRED", "Managed PostgreSQL reconciliation requires operator review", {
    provider: "neon",
    reason,
    ...evidence,
  });
}

function normalizeProviderProjectMatch(project) {
  return {
    id: project?.project?.id ?? project?.id ?? null,
    name: project?.project?.name ?? project?.name ?? null,
  };
}

export async function deleteManagedDatabaseForApp(db, { workspaceId, appId, getProject, deleteProject, listProjectsByName = null }) {
  const result = await db.query(
    `SELECT *
       FROM app_databases
      WHERE app_id=$1
      FOR UPDATE`,
    [appId],
  );
  if (result.rowCount === 0) return { action: "skip", databaseMode: DatabaseMode.NONE, providerDeleted: false };
  const row = result.rows[0];
  assertManagedDatabaseBelongsToApp(row, { workspaceId, appId });
  if (!row.database_mode) throw new Error("Unknown database ownership mode refuses destructive database action");
  if (row.database_mode === DatabaseMode.EXTERNAL) return { action: "skip", databaseMode: DatabaseMode.EXTERNAL, providerDeleted: false };
  if (row.database_mode !== DatabaseMode.SSC_MANAGED) throw new Error(`Unsupported database ownership mode: ${row.database_mode}`);
  if (row.status === ManagedDatabaseStatus.DELETED) {
    return { action: "noop", databaseMode: DatabaseMode.SSC_MANAGED, providerDeleted: false, status: ManagedDatabaseStatus.DELETED };
  }
  if (row.provider !== "neon") throw new Error(`Unsupported managed database provider: ${row.provider}`);
  if (!row.provider_project_id || !row.provider_project_name) {
    if (row.status === ManagedDatabaseStatus.INTENT_RECORDED && !row.provider_project_id) {
      await db.query(
        `UPDATE app_databases
            SET status='DELETED',
                deleted_at=COALESCE(deleted_at,now()),
                delete_error_code=NULL,
                delete_error_message=NULL,
                updated_at=now()
          WHERE id=$1`,
        [row.id],
      );
      return { action: "deleted", databaseMode: DatabaseMode.SSC_MANAGED, providerDeleted: false, providerNotFound: true };
    }
    if (!row.provider_project_name || typeof listProjectsByName !== "function") {
      throw new Error("Managed database deletion requires provider identity");
    }
    const matches = (await listProjectsByName(row.provider_project_name))
      .map(normalizeProviderProjectMatch)
      .filter((project) => project.id && project.name === row.provider_project_name);
    if (matches.length > 1) {
      await db.query(
        `UPDATE app_databases
            SET status='DELETE_FAILED',
                delete_error_code='DATABASE_DELETE_AMBIGUOUS_PROVIDER_IDENTITY',
                delete_error_message='Multiple provider projects match managed database name',
                updated_at=now()
          WHERE id=$1`,
        [row.id],
      );
      throw new Error("Managed database deletion found ambiguous provider identity");
    }
    if (matches.length === 0) {
      await db.query(
        `UPDATE app_databases
            SET status='DELETED',
                deleted_at=COALESCE(deleted_at,now()),
                delete_error_code=NULL,
                delete_error_message=NULL,
                updated_at=now()
          WHERE id=$1`,
        [row.id],
      );
      return {
        action: "deleted",
        databaseMode: DatabaseMode.SSC_MANAGED,
        providerDeleted: false,
        providerNotFound: true,
        reconciledMissingProvider: true,
      };
    }
    row.provider_project_id = matches[0].id;
    row.provider_project_name = matches[0].name;
    await db.query(
      `UPDATE app_databases
          SET provider_project_id=$1,
              provider_project_name=$2,
              status='DELETING',
              delete_error_code=NULL,
              delete_error_message=NULL,
              metadata=metadata || $3::jsonb,
              updated_at=now()
        WHERE id=$4`,
      [row.provider_project_id, row.provider_project_name, JSON.stringify({ reconciledForDeletion: true }), row.id],
    );
  }

  await db.query(
    `UPDATE app_databases
        SET status='DELETING',
            delete_error_code=NULL,
            delete_error_message=NULL,
            updated_at=now()
      WHERE id=$1`,
    [row.id],
  );

  try {
    const remoteProject = await getProject(row.provider_project_id);
    if (remoteProject) {
      const remoteName = remoteProject.project?.name ?? remoteProject.name;
      const remoteId = remoteProject.project?.id ?? remoteProject.id;
      if (remoteId !== row.provider_project_id || remoteName !== row.provider_project_name) {
        throw new Error("Managed database provider identity mismatch before delete");
      }
    }
    const deleted = await deleteProject(row.provider_project_id);
    await db.query(
      `UPDATE app_databases
          SET status='DELETED',
              deleted_at=COALESCE(deleted_at,now()),
              delete_error_code=NULL,
              delete_error_message=NULL,
              updated_at=now()
        WHERE id=$1`,
      [row.id],
    );
    return {
      action: "deleted",
      databaseMode: DatabaseMode.SSC_MANAGED,
      provider: row.provider,
      providerProjectId: row.provider_project_id,
      providerProjectName: row.provider_project_name,
      providerDeleted: deleted.deleted,
      providerNotFound: deleted.notFound,
    };
  } catch (error) {
    await db.query(
      `UPDATE app_databases
          SET status='DELETE_FAILED',
              delete_error_code='DATABASE_DELETE_FAILED',
              delete_error_message=$1,
              updated_at=now()
        WHERE id=$2`,
      [String(error?.message ?? "Managed database deletion failed").slice(0, 1000), row.id],
    );
    throw error;
  }
}

export async function recordDatabaseEvent(db, deployment, eventType, message, metadata = {}) {
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,$2,$2,$3,$4,$5::jsonb)`,
    [deployment.id, deployment.status, eventType, message, JSON.stringify(metadata)],
  );
}
