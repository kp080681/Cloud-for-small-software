export const ACTIVE_DEPLOYMENT_STATES = Object.freeze([
  "DRAFT",
  "READY",
  "QUEUED",
  "ANALYZING",
  "PROVISIONING",
  "BUILDING",
  "DEPLOYING",
  "HEALTH_CHECKING",
  "DELETING",
]);

export const ACTIVE_PROVIDER_OPERATION_STATUSES = Object.freeze([
  "INTENT_RECORDED",
  "CREATE_REQUESTED",
]);

export const DEFAULT_WORKSPACE_RESOURCE_POLICY = Object.freeze({
  maxActiveApps: 3,
  maxActiveDeployments: 3,
  maxActiveDeploymentsPerApp: 1,
  maxConcurrentProviderOperations: 2,
});

export class WorkspaceResourcePolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkspaceResourcePolicyError";
    this.code = code;
    this.details = details;
  }
}

export function validateWorkspaceResourcePolicy(policy) {
  const normalized = normalizePolicy(policy);
  const constraints = [
    ["maxActiveApps", 0, 50],
    ["maxActiveDeployments", 0, 100],
    ["maxActiveDeploymentsPerApp", 0, 20],
    ["maxConcurrentProviderOperations", 0, 20],
  ];
  for (const [field, min, max] of constraints) {
    const value = normalized[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new WorkspaceResourcePolicyError(
        "WORKSPACE_POLICY_INVALID",
        `${field} must be an integer between ${min} and ${max}`,
        { field, min, max },
      );
    }
  }
  return normalized;
}

export function activeAppLimitDecision({ activeAppCount, policy }) {
  const limit = normalizePolicy(policy).maxActiveApps;
  return limitDecision({
    code: "WORKSPACE_APP_LIMIT_REACHED",
    allowed: Number(activeAppCount) < limit,
    observed: Number(activeAppCount),
    limit,
    message: `Workspace active app limit reached: ${activeAppCount}/${limit}.`,
  });
}

export function activeDeploymentLimitDecision({ appActiveDeploymentCount, workspaceActiveDeploymentCount, policy }) {
  const normalized = normalizePolicy(policy);
  const appObserved = Number(appActiveDeploymentCount);
  const workspaceObserved = Number(workspaceActiveDeploymentCount);
  if (appObserved >= normalized.maxActiveDeploymentsPerApp) {
    return limitDecision({
      code: "APP_DEPLOYMENT_LIMIT_REACHED",
      allowed: false,
      observed: appObserved,
      limit: normalized.maxActiveDeploymentsPerApp,
      message: `App active deployment limit reached: ${appObserved}/${normalized.maxActiveDeploymentsPerApp}.`,
    });
  }
  if (workspaceObserved >= normalized.maxActiveDeployments) {
    return limitDecision({
      code: "WORKSPACE_DEPLOYMENT_LIMIT_REACHED",
      allowed: false,
      observed: workspaceObserved,
      limit: normalized.maxActiveDeployments,
      message: `Workspace active deployment limit reached: ${workspaceObserved}/${normalized.maxActiveDeployments}.`,
    });
  }
  return { allowed: true };
}

export function providerOperationLimitDecision({ activeProviderOperationCount, policy }) {
  const limit = normalizePolicy(policy).maxConcurrentProviderOperations;
  return limitDecision({
    code: "WORKSPACE_PROVIDER_OPERATION_LIMIT_REACHED",
    allowed: Number(activeProviderOperationCount) < limit,
    observed: Number(activeProviderOperationCount),
    limit,
    message: `Workspace provider operation limit reached: ${activeProviderOperationCount}/${limit}.`,
  });
}

export async function lockWorkspacePolicy(db, workspaceId) {
  const workspace = await db.query(
    `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`,
    [workspaceId],
  );
  if (workspace.rowCount !== 1) throw new Error(`Workspace not found: ${workspaceId}`);

  await db.query(
    `INSERT INTO workspace_resource_policies
       (workspace_id, max_active_apps, max_active_deployments, max_active_deployments_per_app, max_concurrent_provider_operations)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [
      workspaceId,
      DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveApps,
      DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveDeployments,
      DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveDeploymentsPerApp,
      DEFAULT_WORKSPACE_RESOURCE_POLICY.maxConcurrentProviderOperations,
    ],
  );

  const result = await db.query(
    `SELECT workspace_id,
            max_active_apps,
            max_active_deployments,
            max_active_deployments_per_app,
            max_concurrent_provider_operations
       FROM workspace_resource_policies
      WHERE workspace_id=$1
      FOR UPDATE`,
    [workspaceId],
  );
  if (result.rowCount !== 1) throw new Error(`Workspace resource policy not found: ${workspaceId}`);
  return normalizePolicy(result.rows[0]);
}

export async function enforceActiveAppLimit(db, { workspaceId }) {
  const policy = await lockWorkspacePolicy(db, workspaceId);
  const result = await db.query(
    `SELECT count(*)::int AS count
       FROM apps
      WHERE workspace_id=$1
        AND deleted_at IS NULL`,
    [workspaceId],
  );
  const decision = activeAppLimitDecision({
    activeAppCount: result.rows[0].count,
    policy,
  });
  if (!decision.allowed) throw policyError(decision);
  return { policy, activeAppCount: result.rows[0].count };
}

export async function enforceDeploymentCreationLimit(db, { workspaceId, appId }) {
  const policy = await lockWorkspacePolicy(db, workspaceId);
  const appCount = await db.query(
    `SELECT count(*)::int AS count
       FROM deployments
      WHERE app_id=$1
        AND status = ANY($2::deployment_status[])`,
    [appId, ACTIVE_DEPLOYMENT_STATES],
  );
  const workspaceCount = await db.query(
    `SELECT count(*)::int AS count
       FROM deployments
      WHERE workspace_id=$1
        AND status = ANY($2::deployment_status[])`,
    [workspaceId, ACTIVE_DEPLOYMENT_STATES],
  );
  const decision = activeDeploymentLimitDecision({
    appActiveDeploymentCount: appCount.rows[0].count,
    workspaceActiveDeploymentCount: workspaceCount.rows[0].count,
    policy,
  });
  if (!decision.allowed) throw policyError(decision);
  return {
    policy,
    appActiveDeploymentCount: appCount.rows[0].count,
    workspaceActiveDeploymentCount: workspaceCount.rows[0].count,
  };
}

export async function ensureBuildOperationWithinWorkspaceLimit(db, deployment) {
  await db.query("BEGIN");
  try {
    const existing = await db.query(
      `SELECT id, deployment_id, status, provider_resource_id, source_commit_sha
         FROM deployment_provider_operations
        WHERE deployment_id=$1
          AND operation_type='vercel-create-deployment'
        FOR UPDATE`,
      [deployment.id],
    );
    if (existing.rowCount === 1) {
      await db.query("COMMIT");
      return { operation: existing.rows[0], createdNewOperation: false, allowed: true };
    }

    const policy = await lockWorkspacePolicy(db, deployment.workspace_id);
    const active = await db.query(
      `SELECT count(*)::int AS count
         FROM deployment_provider_operations o
         JOIN deployments d ON d.id=o.deployment_id
        WHERE d.workspace_id=$1
          AND o.operation_type IN ('vercel-create-deployment')
          AND o.status = ANY($2::text[])`,
      [deployment.workspace_id, ACTIVE_PROVIDER_OPERATION_STATUSES],
    );
    const decision = providerOperationLimitDecision({
      activeProviderOperationCount: active.rows[0].count,
      policy,
    });
    if (!decision.allowed) {
      await recordDeploymentPolicyBlock(db, {
        deploymentId: deployment.id,
        status: deployment.status,
        decision,
      });
      await db.query("COMMIT");
      return { operation: null, createdNewOperation: false, allowed: false, decision };
    }

    const result = await db.query(
      `INSERT INTO deployment_provider_operations
         (deployment_id, operation_type, provider, idempotency_key, source_commit_sha,
          provider_project_id, status, metadata)
       VALUES ($1,'vercel-create-deployment','vercel',$2,$3,$4,'INTENT_RECORDED',$5::jsonb)
       RETURNING id, deployment_id, status, provider_resource_id, source_commit_sha`,
      [
        deployment.id,
        deployment.idempotency_key,
        deployment.commit_sha,
        deployment.provider_project_id,
        JSON.stringify({ target: "production", providerProjectId: deployment.provider_project_id }),
      ],
    );
    await db.query("COMMIT");
    return { operation: result.rows[0], createdNewOperation: true, allowed: true };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

function normalizePolicy(policy = {}) {
  return {
    maxActiveApps: Number(policy.maxActiveApps ?? policy.max_active_apps ?? DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveApps),
    maxActiveDeployments: Number(policy.maxActiveDeployments ?? policy.max_active_deployments ?? DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveDeployments),
    maxActiveDeploymentsPerApp: Number(policy.maxActiveDeploymentsPerApp ?? policy.max_active_deployments_per_app ?? DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveDeploymentsPerApp),
    maxConcurrentProviderOperations: Number(policy.maxConcurrentProviderOperations ?? policy.max_concurrent_provider_operations ?? DEFAULT_WORKSPACE_RESOURCE_POLICY.maxConcurrentProviderOperations),
  };
}

function limitDecision({ code, allowed, observed, limit, message }) {
  return allowed ? { allowed: true } : { allowed: false, code, observed, limit, message };
}

function policyError(decision) {
  return new WorkspaceResourcePolicyError(decision.code, decision.message, {
    observed: decision.observed,
    limit: decision.limit,
  });
}

async function recordDeploymentPolicyBlock(db, { deploymentId, status, decision }) {
  await db.query(
    `UPDATE deployments
        SET error_code=$1,
            error_message=$2,
            updated_at=now()
      WHERE id=$3`,
    [decision.code, decision.message, deploymentId],
  );
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,$2,$2,'RESOURCE_POLICY_BLOCKED',$3,$4::jsonb)`,
    [deploymentId, status, decision.message, JSON.stringify({
      code: decision.code,
      observed: decision.observed,
      limit: decision.limit,
      scope: "workspace",
    })],
  );
}
