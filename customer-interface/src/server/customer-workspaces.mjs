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
  };
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
        latest.status AS latest_deployment_status,
        latest.live_url
      FROM customer_workspace_memberships cwm
      JOIN apps a ON a.workspace_id = cwm.workspace_id
      LEFT JOIN LATERAL (
        SELECT d.status, d.live_url
        FROM deployments d
        WHERE d.app_id = a.id
        ORDER BY d.created_at DESC
        LIMIT 1
      ) latest ON true
      WHERE cwm.customer_identity_id = $1
        AND cwm.workspace_id = $2
        AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC
    `,
    [customerId, workspaceId],
  );
  return result.rows.map(safeApplication);
}
