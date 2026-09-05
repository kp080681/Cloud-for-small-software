const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireOperatorEnv(name, env = process.env) {
  const value = env[name]?.trim?.() ?? env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function requireWorkspaceId(env = process.env) {
  const workspaceId = requireOperatorEnv("CONTROL_PLANE_WORKSPACE_ID", env);
  if (!UUID_RE.test(workspaceId)) throw new Error("CONTROL_PLANE_WORKSPACE_ID must be a UUID");
  return workspaceId;
}

export function optionalAppId(env = process.env) {
  const appId = env.CONTROL_PLANE_APP_ID?.trim?.() ?? env.CONTROL_PLANE_APP_ID;
  if (!appId) return null;
  if (!UUID_RE.test(appId)) throw new Error("CONTROL_PLANE_APP_ID must be a UUID");
  return appId;
}

export function optionalDeploymentId(env = process.env) {
  const deploymentId = env.CONTROL_PLANE_DEPLOYMENT_ID?.trim?.() ?? env.CONTROL_PLANE_DEPLOYMENT_ID;
  if (!deploymentId) return null;
  if (!UUID_RE.test(deploymentId)) throw new Error("CONTROL_PLANE_DEPLOYMENT_ID must be a UUID");
  return deploymentId;
}

export function requireAppSlug(env = process.env) {
  const slug = env.CONTROL_PLANE_APP_SLUG?.trim?.() ?? env.CONTROL_PLANE_APP_SLUG;
  if (!slug) throw new Error("Missing required environment variable: CONTROL_PLANE_APP_SLUG");
  return slug;
}

function activePredicate(includeDeleted) {
  return includeDeleted ? "" : "deleted_at IS NULL";
}

export function assertResolvedAppTarget(rows, { workspaceId, appId = null, slug = null } = {}) {
  if (!workspaceId) throw new Error("Operator app targeting requires workspaceId");
  if (!appId && !slug) throw new Error("Operator app targeting requires appId or slug");
  if (rows.length === 0) {
    throw new Error(`App target not found for workspace ${workspaceId}`);
  }
  if (rows.length > 1) {
    throw new Error(`Ambiguous app target for workspace ${workspaceId}; refusing to choose one`);
  }

  const app = rows[0];
  if (app.workspace_id !== workspaceId) {
    throw new Error("App target workspace mismatch; refusing operator action");
  }
  if (appId && app.id !== appId) {
    throw new Error("App target appId mismatch; refusing operator action");
  }
  if (slug && app.slug?.toLowerCase?.() !== slug.toLowerCase()) {
    throw new Error("App target slug mismatch; refusing operator action");
  }
  return app;
}

export async function resolveAppTarget(db, {
  workspaceId,
  appId = null,
  slug = null,
  includeDeleted = false,
  forUpdate = false,
} = {}) {
  if (!workspaceId) throw new Error("Operator app targeting requires workspaceId");
  if (!appId && !slug) throw new Error("Operator app targeting requires appId or slug");

  const params = [workspaceId];
  const clauses = [`workspace_id = $1`, activePredicate(includeDeleted)];
  if (appId) {
    params.push(appId);
    clauses.push(`id = $${params.length}`);
  }
  if (slug) {
    params.push(slug);
    clauses.push(`lower(slug) = lower($${params.length})`);
  }

  const result = await db.query(
    `SELECT id, workspace_id, repository_id, name, slug, framework, runtime, database_required, deleted_at
       FROM apps
      WHERE ${clauses.filter(Boolean).join(" AND ")}
      ${forUpdate ? "FOR UPDATE" : ""}`,
    params,
  );

  return assertResolvedAppTarget(result.rows, { workspaceId, appId, slug });
}

export async function resolveLatestDeploymentForAppTarget(db, {
  workspaceId,
  appId = null,
  slug = null,
} = {}) {
  const app = await resolveAppTarget(db, { workspaceId, appId, slug });
  const result = await db.query(
    `SELECT d.id,
            d.deployment_key,
            d.status,
            d.source_commit_sha,
            d.live_url,
            d.runtime_project_id,
            a.id AS app_id,
            a.workspace_id,
            a.name AS app_name,
            a.slug AS app_slug
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
      WHERE d.app_id = $1
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [app.id],
  );
  if (result.rowCount === 0) throw new Error(`No deployment found for app target: ${app.slug}`);
  return result.rows[0];
}

export async function resolveDeploymentTarget(db, {
  deploymentId,
  workspaceId = null,
  appId = null,
  slug = null,
} = {}) {
  if (!deploymentId) throw new Error("Operator deployment targeting requires deploymentId");
  const result = await db.query(
    `SELECT d.id,
            d.deployment_key,
            d.status,
            d.source_commit_sha,
            d.live_url,
            d.runtime_project_id,
            a.id AS app_id,
            a.workspace_id,
            a.name AS app_name,
            a.slug AS app_slug
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
      WHERE d.id = $1`,
    [deploymentId],
  );
  if (result.rowCount === 0) throw new Error(`Deployment not found: ${deploymentId}`);
  const deployment = result.rows[0];
  if (workspaceId && deployment.workspace_id !== workspaceId) {
    throw new Error("Deployment target workspace mismatch; refusing operator action");
  }
  if (appId && deployment.app_id !== appId) {
    throw new Error("Deployment target appId mismatch; refusing operator action");
  }
  if (slug && deployment.app_slug?.toLowerCase?.() !== slug.toLowerCase()) {
    throw new Error("Deployment target slug mismatch; refusing operator action");
  }
  return deployment;
}
