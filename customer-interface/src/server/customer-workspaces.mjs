import { alertNewSignup } from "./owner-alerts.mjs";

export function defaultWorkspaceName(identity) {
  const login = String(identity?.login || "Personal").trim().slice(0, 48);
  return `${login} workspace`;
}

export function sanitizeWorkspaceName(name) {
  const normalized = String(name || "").trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 80) {
    throw Object.assign(new Error("Workspace name must be between 1 and 80 characters."), {
      status: 400,
      code: "INVALID_WORKSPACE_NAME",
    });
  }
  return normalized;
}

export function safeWorkspace(row) {
  return {
    id: row.id,
    name: row.name,
  };
}

export function safeApplication(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    framework: row.framework,
    runtime: row.runtime,
    databaseRequired: row.database_required,
    latestDeploymentStatus: row.latest_deployment_status ?? null,
    liveUrl: row.live_url ?? null,
    autoDeployOnPush: row.auto_deploy_on_push !== false,
    repositoryId: row.repository_id ?? null,
    repositoryFullName: row.repository_full_name ?? null,
    defaultBranch: row.default_branch ?? null,
    latestDeploymentReason: row.latest_deployment_reason ?? null,
    latestDeploymentStarted: Boolean(row.latest_deployment_started),
    liveCommitSha: row.live_commit_sha ?? null,
    liveDeployedAt: toIso(row.live_deployed_at),
  };
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function upsertCustomerIdentity(db, identity) {
  const result = await db.query(
    `
      INSERT INTO customer_identities (
        provider,
        provider_account_id,
        login,
        display_name,
        avatar_url
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider, provider_account_id)
      DO UPDATE SET
        login = EXCLUDED.login,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = now()
      RETURNING id, provider, provider_account_id, login, display_name, avatar_url
    `,
    [
      identity.provider,
      identity.providerAccountId,
      identity.login,
      identity.displayName ?? identity.login,
      identity.avatarUrl ?? null,
    ],
  );
  return result.rows[0];
}

export async function ensureInitialWorkspace(db, { customerId, workspaceName }) {
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`customer-initial-workspace:${customerId}`]);
    const existing = await db.query(
      `
        SELECT w.id, w.name
        FROM customer_workspace_memberships cwm
        JOIN workspaces w ON w.id = cwm.workspace_id
        WHERE cwm.customer_identity_id = $1
        ORDER BY cwm.created_at ASC
        LIMIT 1
      `,
      [customerId],
    );

    if (existing.rows[0]) {
      await db.query("COMMIT");
      return safeWorkspace(existing.rows[0]);
    }

    const created = await db.query(
      `
        INSERT INTO workspaces (name)
        VALUES ($1)
        RETURNING id, name
      `,
      [sanitizeWorkspaceName(workspaceName)],
    );
    const workspace = created.rows[0];
    await db.query(
      `
        INSERT INTO customer_workspace_memberships (
          customer_identity_id,
          workspace_id,
          role
        )
        VALUES ($1, $2, 'owner')
        ON CONFLICT (customer_identity_id, workspace_id) DO NOTHING
      `,
      [customerId, workspace.id],
    );
    await db.query("COMMIT");
    // Reaching here means this person had no workspace: a new sign-up.
    // Every entry point (web sign-in, MCP connect) comes through here.
    await alertNewSignup(db, { customerId });
    return safeWorkspace(workspace);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function listAuthorizedWorkspaces(db, { customerId }) {
  const result = await db.query(
    `
      SELECT w.id, w.name
      FROM customer_workspace_memberships cwm
      JOIN workspaces w ON w.id = cwm.workspace_id
      WHERE cwm.customer_identity_id = $1
      ORDER BY cwm.created_at ASC
    `,
    [customerId],
  );
  return result.rows.map(safeWorkspace);
}

export async function getAuthorizedWorkspace(db, { customerId, workspaceId }) {
  const result = await db.query(
    `
      SELECT w.id, w.name
      FROM customer_workspace_memberships cwm
      JOIN workspaces w ON w.id = cwm.workspace_id
      WHERE cwm.customer_identity_id = $1
        AND w.id = $2
      LIMIT 1
    `,
    [customerId, workspaceId],
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Workspace not found."), {
      status: 404,
      code: "WORKSPACE_NOT_FOUND",
    });
  }
  return safeWorkspace(result.rows[0]);
}

export async function renameAuthorizedWorkspace(db, { customerId, workspaceId, name }) {
  const safeName = sanitizeWorkspaceName(name);
  await db.query("BEGIN");
  try {
    const target = await db.query(
      `
        SELECT w.id
        FROM customer_workspace_memberships cwm
        JOIN workspaces w ON w.id = cwm.workspace_id
        WHERE cwm.customer_identity_id = $1
          AND w.id = $2
        FOR UPDATE OF w
      `,
      [customerId, workspaceId],
    );
    if (!target.rows[0]) {
      throw Object.assign(new Error("Workspace not found."), {
        status: 404,
        code: "WORKSPACE_NOT_FOUND",
      });
    }

    const updated = await db.query(
      `
        UPDATE workspaces
        SET name = $1,
            updated_at = now()
        WHERE id = $2
        RETURNING id, name
      `,
      [safeName, workspaceId],
    );
    await db.query("COMMIT");
    return safeWorkspace(updated.rows[0]);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function listWorkspaceApplications(db, { customerId, workspaceId }) {
  const result = await db.query(
    `
      SELECT
        a.id,
        a.name,
        a.slug,
        a.framework,
        a.runtime,
        a.database_required,
        a.auto_deploy_on_push,
        a.repository_id,
        r.full_name AS repository_full_name,
        r.default_branch,
        latest.status AS latest_deployment_status,
        latest.deployment_reason AS latest_deployment_reason,
        latest.started AS latest_deployment_started,
        live.live_url,
        live.source_commit_sha AS live_commit_sha,
        live.deployed_at AS live_deployed_at
      FROM customer_workspace_memberships cwm
      JOIN apps a ON a.workspace_id = cwm.workspace_id
      LEFT JOIN github_repositories r ON r.id = a.repository_id
      LEFT JOIN LATERAL (
        SELECT d.status, d.deployment_reason, (d.orchestrator_run_id IS NOT NULL) AS started
        FROM deployments d
        WHERE d.app_id = a.id
        ORDER BY d.created_at DESC
        LIMIT 1
      ) latest ON true
      -- The link comes from the newest LIVE deployment, not the newest
      -- deployment: while a redeploy (e.g. from a push) is running, the
      -- previous version is still serving and still has a working link.
      LEFT JOIN LATERAL (
        SELECT d.live_url, d.source_commit_sha, COALESCE(d.finished_at, d.updated_at) AS deployed_at
        FROM deployments d
        WHERE d.app_id = a.id
          AND d.status = 'LIVE'
          AND d.live_url IS NOT NULL
        ORDER BY d.created_at DESC
        LIMIT 1
      ) live ON true
      WHERE cwm.customer_identity_id = $1
        AND cwm.workspace_id = $2
        AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC
    `,
    [customerId, workspaceId],
  );
  return result.rows.map(safeApplication);
}

export async function setAppAutoDeployOnPush(db, { customerId, workspaceId, appId, enabled }) {
  if (typeof enabled !== "boolean") {
    throw Object.assign(new Error("enabled must be true or false."), { status: 400, code: "INVALID_INPUT" });
  }
  const result = await db.query(
    `UPDATE apps a
        SET auto_deploy_on_push = $4,
            updated_at = now()
       FROM customer_workspace_memberships m
      WHERE a.id = $3
        AND a.workspace_id = $2
        AND a.deleted_at IS NULL
        AND m.workspace_id = a.workspace_id
        AND m.customer_identity_id = $1
      RETURNING a.id, a.auto_deploy_on_push`,
    [customerId, workspaceId, appId, enabled],
  );
  if (result.rowCount !== 1) {
    throw Object.assign(new Error("Application not found in this workspace."), { status: 404, code: "APP_NOT_FOUND" });
  }
  return { appId: result.rows[0].id, autoDeployOnPush: result.rows[0].auto_deploy_on_push };
}

// Recent deployments of one app, newest first, for its history list. Only
// customer-safe fields; scoped by workspace membership like everything else.
export async function listAppDeployments(db, { customerId, workspaceId, appId, limit = 15 }) {
  const result = await db.query(
    `SELECT d.id,
            d.status,
            d.deployment_reason,
            d.source_commit_sha,
            d.source_branch,
            d.error_code,
            d.created_at,
            d.finished_at
       FROM customer_workspace_memberships m
       JOIN apps a ON a.workspace_id = m.workspace_id
       JOIN deployments d ON d.app_id = a.id
      WHERE m.customer_identity_id = $1
        AND m.workspace_id = $2
        AND a.id = $3
        AND a.deleted_at IS NULL
      ORDER BY d.created_at DESC
      LIMIT $4`,
    [customerId, workspaceId, appId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    reason: row.deployment_reason ?? "initial",
    commitSha: row.source_commit_sha ?? null,
    shortCommitSha: row.source_commit_sha ? String(row.source_commit_sha).slice(0, 7) : null,
    branch: row.source_branch ?? null,
    errorCode: row.error_code ?? null,
    createdAt: toIso(row.created_at),
    finishedAt: toIso(row.finished_at),
  }));
}
