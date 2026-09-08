export const DEFAULT_WORKSPACE_RESOURCE_POLICY = Object.freeze({
  maxActiveApps: 3,
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
  const value = normalized.maxActiveApps;
  if (!Number.isInteger(value) || value < 0 || value > 50) {
    throw new WorkspaceResourcePolicyError(
      "WORKSPACE_POLICY_INVALID",
      "maxActiveApps must be an integer between 0 and 50",
      { field: "maxActiveApps", min: 0, max: 50 },
    );
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

export async function lockWorkspacePolicy(db, workspaceId) {
  const workspace = await db.query(
    `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`,
    [workspaceId],
  );
  if (workspace.rowCount !== 1) throw new Error(`Workspace not found: ${workspaceId}`);

  await db.query(
    `INSERT INTO workspace_resource_policies
       (workspace_id, max_active_apps, max_active_deployments, max_active_deployments_per_app, max_concurrent_provider_operations, max_managed_databases)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [
      workspaceId,
      DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveApps,
      3,
      1,
      2,
      3,
    ],
  );

  const result = await db.query(
    `SELECT workspace_id,
            max_active_apps,
            max_active_deployments,
            max_active_deployments_per_app,
            max_concurrent_provider_operations,
            max_managed_databases
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

function normalizePolicy(policy = {}) {
  return {
    maxActiveApps: Number(policy.maxActiveApps ?? policy.max_active_apps ?? DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveApps),
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
