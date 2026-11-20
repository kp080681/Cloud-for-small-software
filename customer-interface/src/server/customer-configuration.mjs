import { encryptAppSecret } from "../shared/control-plane/secret-store.mjs";
import { missingRequiredEnvKeys } from "../shared/control-plane/env-requirement-reconciliation.mjs";
import { getAuthorizedWorkspace } from "./customer-workspaces.mjs";
import { enforceRateLimit } from "../shared/control-plane/rate-limit.mjs";

const TARGET_ENVIRONMENT = "production";
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isManagedRequirement(app, envKey) {
  return envKey === "DATABASE_URL" && app.database_mode === "SSC_MANAGED";
}

function safeTimestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function safeRequirement(row, app) {
  const envKey = row.env_key;
  const managed = isManagedRequirement(app, envKey);
  return {
    envKey,
    required: Boolean(row.required),
    managed,
    configured: managed ? true : Boolean(row.configured),
    public: Boolean(row.public),
    source: row.source,
    updatedAt: safeTimestamp(row.binding_updated_at ?? row.secret_updated_at ?? row.updated_at),
  };
}

function platformManagedDatabaseRequirement(app) {
  return {
    envKey: "DATABASE_URL",
    required: true,
    managed: true,
    configured: true,
    public: false,
    source: "managed-database",
    updatedAt: null,
  };
}

function sortRequirements(requirements) {
  return requirements.sort((a, b) => {
    if (a.managed !== b.managed) return a.managed ? 1 : -1;
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.envKey.localeCompare(b.envKey);
  });
}

function readinessFrom({ deployment, requirements }) {
  if (!deployment) {
    return { readiness: "CONFIGURATION_REQUIRED", blockingCode: "ANALYSIS_REQUIRED", missingKeys: [] };
  }
  if (!deployment.build_input_id) {
    return { readiness: "CONFIGURATION_REQUIRED", blockingCode: "ANALYSIS_REQUIRED", missingKeys: [] };
  }
  if (deployment.error_code) {
    return { readiness: "BLOCKED", blockingCode: deployment.error_code, missingKeys: [] };
  }
  const missingKeys = missingRequiredEnvKeys(
    requirements
      .filter((item) => !item.managed)
      .map((item) => ({ envKey: item.envKey, required: item.required, configured: item.configured })),
  );
  return {
    readiness: missingKeys.length ? "CONFIGURATION_REQUIRED" : "READY_TO_DEPLOY",
    blockingCode: missingKeys.length ? "ENV_CONFIGURATION_REQUIRED" : null,
    missingKeys,
  };
}

function safeConfiguration({ app, deployment, requirements }) {
  const readiness = readinessFrom({ deployment, requirements });
  return {
    appId: app.id,
    deploymentId: deployment?.id ?? null,
    readiness: readiness.readiness,
    blockingCode: readiness.blockingCode,
    missingKeys: readiness.missingKeys,
    requirements,
  };
}

async function loadAuthorizedApp(db, { customerId, workspaceId, appId, forUpdate = false }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const result = await db.query(
    `SELECT id, workspace_id, repository_id, name, slug, framework, runtime,
            database_required, database_mode, deleted_at
       FROM apps
      WHERE workspace_id = $1
        AND id = $2
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [workspaceId, appId],
  );
  const app = result.rows[0];
  if (!app || app.deleted_at) {
    throw Object.assign(new Error("Application not found."), {
      status: 404,
      code: "APPLICATION_NOT_FOUND",
    });
  }
  return app;
}

async function loadLatestAnalyzedDeployment(db, { appId }) {
  const result = await db.query(
    `SELECT d.id, d.status, d.error_code, d.source_commit_sha, d.source_branch,
            bi.id AS build_input_id
       FROM deployments d
       LEFT JOIN deployment_build_inputs bi ON bi.deployment_id = d.id
      WHERE d.app_id = $1
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [appId],
  );
  return result.rows[0] ?? null;
}

async function loadRequirements(db, { app, deploymentId }) {
  const result = await db.query(
    `SELECT r.id, r.env_key, r.required, r.public, r.source, r.updated_at,
            b.id IS NOT NULL AS configured,
            b.updated_at AS binding_updated_at,
            s.updated_at AS secret_updated_at
       FROM app_env_requirements r
       LEFT JOIN app_secret_bindings b
         ON b.app_id = r.app_id
        AND b.env_key = r.env_key
        AND b.target_environment = $2
       LEFT JOIN encrypted_secrets s
         ON s.id = b.secret_id
        AND s.workspace_id = b.workspace_id
        AND s.app_id = b.app_id
      WHERE r.app_id = $1
      ORDER BY r.env_key`,
    [app.id, TARGET_ENVIRONMENT],
  );
  const requirementsByKey = new Map(result.rows.map((row) => [row.env_key, safeRequirement(row, app)]));

  if (deploymentId) {
    const detections = await db.query(
      `SELECT det.env_key, det.public
         FROM deployment_env_requirement_detections det
        WHERE det.deployment_id = $1
        ORDER BY det.env_key`,
      [deploymentId],
    );
    for (const row of detections.rows) {
      if (!requirementsByKey.has(row.env_key)) {
        requirementsByKey.set(row.env_key, {
          envKey: row.env_key,
          required: false,
          managed: isManagedRequirement(app, row.env_key),
          configured: isManagedRequirement(app, row.env_key),
          public: Boolean(row.public),
          source: "source-detection",
          updatedAt: null,
        });
      }
    }
  }

  if (app.database_required && app.database_mode === "SSC_MANAGED" && !requirementsByKey.has("DATABASE_URL")) {
    requirementsByKey.set("DATABASE_URL", platformManagedDatabaseRequirement(app));
  }

  return sortRequirements([...requirementsByKey.values()]);
}

// A deployment stopped at ANALYZING with ENV_CONFIGURATION_REQUIRED used to
// stay stopped for good: saving the missing settings never cleared the
// code, the start path saw the earlier run and did nothing, and the resume
// path refused anything with an error code. The dashboard then showed the
// fallback "This repository isn't supported yet." Found deploying DealUp
// Books (2026-11-16). Once nothing required is missing, clear the block and
// record why, so the deployment can be continued. Runs inside the caller's
// transaction; returns the deployment id it released, or null.
async function clearResolvedEnvBlock(db, { app }) {
  const latest = await db.query(
    `SELECT id, status, error_code
       FROM deployments
      WHERE app_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [app.id],
  );
  const deployment = latest.rows[0];
  if (!deployment || deployment.status !== "ANALYZING" || deployment.error_code !== "ENV_CONFIGURATION_REQUIRED") return null;
  const requirements = await loadRequirements(db, { app, deploymentId: deployment.id });
  const stillMissing = missingRequiredEnvKeys(
    requirements
      .filter((item) => !item.managed)
      .map((item) => ({ envKey: item.envKey, required: item.required, configured: item.configured })),
  );
  if (stillMissing.length) return null;
  const released = await db.query(
    `UPDATE deployments
        SET error_code = NULL,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1
        AND status = 'ANALYZING'
        AND error_code = 'ENV_CONFIGURATION_REQUIRED'
      RETURNING id`,
    [deployment.id],
  );
  if (released.rowCount !== 1) return null;
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,'ANALYZING','ANALYZING','ENV_REQUIREMENTS_RESOLVED',
             'Required configuration saved; deployment can continue', $2::jsonb)`,
    [deployment.id, JSON.stringify({ valuesPrinted: false })],
  );
  return deployment.id;
}

// For a deployment that was already stuck before the fix above existed:
// every required setting is saved, but the block was never cleared.
export async function releaseResolvedEnvBlock(db, { customerId, workspaceId, appId }) {
  await db.query("BEGIN");
  try {
    const app = await loadAuthorizedApp(db, { customerId, workspaceId, appId, forUpdate: true });
    const releasedDeploymentId = await clearResolvedEnvBlock(db, { app });
    await db.query("COMMIT");
    return releasedDeploymentId;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function getDeploymentReadiness(db, { customerId, workspaceId, appId }) {
  const app = await loadAuthorizedApp(db, { customerId, workspaceId, appId });
  const deployment = await loadLatestAnalyzedDeployment(db, { appId: app.id });
  const requirements = await loadRequirements(db, { app, deploymentId: deployment?.id ?? null });
  return safeConfiguration({ app, deployment, requirements });
}

export async function listWorkspaceConfigurationStatuses(db, { customerId, workspaceId }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const apps = await db.query(
    `SELECT id
       FROM apps
      WHERE workspace_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  const statuses = [];
  for (const row of apps.rows) {
    statuses.push(await getDeploymentReadiness(db, { customerId, workspaceId, appId: row.id }));
  }
  return statuses;
}

export async function saveCustomerAppSecret(
  db,
  { customerId, workspaceId, appId, envKey, plaintext, encryptSecret = encryptAppSecret },
) {
  const safeEnvKey = String(envKey || "").trim();
  if (!ENV_KEY_PATTERN.test(safeEnvKey)) {
    throw Object.assign(new Error("Environment key is invalid."), {
      status: 400,
      code: "INVALID_ENV_KEY",
    });
  }
  if (typeof plaintext !== "string" || plaintext.length < 1) {
    throw Object.assign(new Error("Secret value is required."), {
      status: 400,
      code: "SECRET_VALUE_REQUIRED",
    });
  }

  // Authorize before charging anything against the rate-limit budget — an
  // independent review (Opus 5.5) found this call used to run before any
  // check that appId belonged to workspaceId at all, letting a caller
  // burn another workspace's secret_write budget just by supplying its
  // UUIDs. Non-locking (no forUpdate) since this is a pre-check, not the
  // authoritative load — loadAuthorizedApp runs again with forUpdate:true
  // inside the transaction below, the same defense-in-depth pattern used
  // throughout this codebase.
  await loadAuthorizedApp(db, { customerId, workspaceId, appId });

  // AWS KMS charges per Encrypt call regardless of whether any workspace
  // resource-count ceiling is hit, so this is bounded independently of
  // active-app/active-deployment limits. 60/hour is generous for legitimate
  // configuration work (an app rarely has more than a handful of secrets)
  // while bounding a scripted or looping caller from generating real cost.
  await enforceRateLimit(db, {
    workspaceId,
    action: "secret_write",
    limit: 60,
    windowSeconds: 3600,
  });

  await db.query("BEGIN");
  try {
    const app = await loadAuthorizedApp(db, { customerId, workspaceId, appId, forUpdate: true });
    const requirement = await db.query(
      `SELECT id, env_key, required, public, source
         FROM app_env_requirements
        WHERE app_id = $1
          AND env_key = $2
        LIMIT 1
        FOR UPDATE`,
      [app.id, safeEnvKey],
    );
    const requirementRow = requirement.rows[0];
    if (!requirementRow) {
      throw Object.assign(new Error("Environment key is not approved for this application."), {
        status: 400,
        code: "ENV_KEY_NOT_APPROVED",
      });
    }
    if (isManagedRequirement(app, safeEnvKey)) {
      throw Object.assign(new Error("Environment key is managed by Utplava."), {
        status: 400,
        code: "ENV_KEY_PLATFORM_MANAGED",
      });
    }

    const stored = await encryptSecret(db, {
      workspaceId: app.workspace_id,
      appId: app.id,
      name: safeEnvKey,
      plaintext,
    });
    await db.query(
      `INSERT INTO app_secret_bindings
         (workspace_id, app_id, env_key, secret_id, target_environment)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (app_id, env_key, target_environment) DO UPDATE SET
         secret_id = EXCLUDED.secret_id,
         updated_at = now()
       RETURNING id, updated_at`,
      [app.workspace_id, app.id, safeEnvKey, stored.id, TARGET_ENVIRONMENT],
    );
    const releasedDeploymentId = await clearResolvedEnvBlock(db, { app });

    await db.query("COMMIT");
    const configuration = await getDeploymentReadiness(db, { customerId, workspaceId, appId: app.id });
    return {
      envKey: safeEnvKey,
      configured: true,
      configuration,
      releasedDeploymentId,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
