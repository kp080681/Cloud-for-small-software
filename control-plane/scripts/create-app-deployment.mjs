import crypto from "node:crypto";
import pg from "pg";

const required = ["DATABASE_URL", "CONTROL_PLANE_REPOSITORY", "CONTROL_PLANE_COMMIT_SHA"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const repositoryFullName = process.env.CONTROL_PLANE_REPOSITORY;
const commitSha = process.env.CONTROL_PLANE_COMMIT_SHA;
const branch = process.env.CONTROL_PLANE_BRANCH || "main";
const appName = process.env.CONTROL_PLANE_APP_NAME || repositoryFullName.split("/").at(-1);
const slug = (process.env.CONTROL_PLANE_APP_SLUG || appName)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const framework = process.env.CONTROL_PLANE_FRAMEWORK || "nextjs";
const runtime = process.env.CONTROL_PLANE_RUNTIME || "nodejs";
const databaseRequired = (process.env.CONTROL_PLANE_DATABASE_REQUIRED || "false").toLowerCase() === "true";

if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("CONTROL_PLANE_COMMIT_SHA must be a 40-character Git SHA");
if (!slug) throw new Error("App slug resolved to an empty value");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  await db.query("BEGIN");

  const repoResult = await db.query(
    `SELECT r.id, r.workspace_id, r.full_name, r.default_branch
       FROM github_repositories r
      WHERE lower(r.full_name) = lower($1)
      LIMIT 1
      FOR UPDATE`,
    [repositoryFullName],
  );
  if (repoResult.rowCount === 0) throw new Error(`Repository is not mapped in the control plane: ${repositoryFullName}`);
  const repository = repoResult.rows[0];

  const existingApp = await db.query(
    `SELECT id, workspace_id, repository_id, name, slug, framework, runtime, database_required
       FROM apps
      WHERE workspace_id = $1 AND slug = $2
      LIMIT 1
      FOR UPDATE`,
    [repository.workspace_id, slug],
  );

  let app;
  if (existingApp.rowCount > 0) {
    if (existingApp.rows[0].repository_id !== repository.id) {
      throw new Error(`App slug already belongs to another repository: ${slug}`);
    }
    const updated = await db.query(
      `UPDATE apps
          SET name = $1,
              framework = $2,
              runtime = $3,
              database_required = $4,
              updated_at = now()
        WHERE id = $5
        RETURNING id, workspace_id, repository_id, name, slug, framework, runtime, database_required`,
      [appName, framework, runtime, databaseRequired, existingApp.rows[0].id],
    );
    app = updated.rows[0];
  } else {
    const created = await db.query(
      `INSERT INTO apps
         (workspace_id, repository_id, name, slug, framework, runtime, database_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, workspace_id, repository_id, name, slug, framework, runtime, database_required`,
      [repository.workspace_id, repository.id, appName, slug, framework, runtime, databaseRequired],
    );
    app = created.rows[0];
  }

  // Deployment identity is immutable: app + exact source SHA. Re-running the command for
  // the same revision returns the same deployment instead of creating duplicate work.
  const existingDeployment = await db.query(
    `SELECT id, deployment_key, source_commit_sha, source_branch, status, created_at
       FROM deployments
      WHERE app_id = $1 AND source_commit_sha = $2
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE`,
    [app.id, commitSha],
  );

  let deployment;
  let createdDeployment = false;
  if (existingDeployment.rowCount > 0) {
    deployment = existingDeployment.rows[0];
  } else {
    const deploymentKey = `dep_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = await db.query(
      `INSERT INTO deployments
         (deployment_key, workspace_id, app_id, source_commit_sha, source_branch, status)
       VALUES ($1, $2, $3, $4, $5, 'READY')
       RETURNING id, deployment_key, source_commit_sha, source_branch, status, created_at`,
      [deploymentKey, repository.workspace_id, app.id, commitSha, branch],
    );
    deployment = created.rows[0];
    createdDeployment = true;

    await db.query(
      `INSERT INTO deployment_events
         (deployment_id, from_status, to_status, event_type, message, metadata)
       VALUES ($1, 'DRAFT', 'READY', 'STATUS_CHANGED', $2, $3::jsonb)`,
      [
        deployment.id,
        "Application source accepted and deployment is ready to queue",
        JSON.stringify({ repository: repository.full_name, commitSha, branch }),
      ],
    );
  }

  await db.query("COMMIT");

  console.log(JSON.stringify({
    result: "NODE_04_4_CREATED",
    workspaceId: repository.workspace_id,
    repository: repository.full_name,
    app: {
      id: app.id,
      name: app.name,
      slug: app.slug,
      framework: app.framework,
      runtime: app.runtime,
      databaseRequired: app.database_required,
    },
    deployment: {
      id: deployment.id,
      key: deployment.deployment_key,
      commitSha: deployment.source_commit_sha,
      branch: deployment.source_branch,
      status: deployment.status,
      newlyCreated: createdDeployment,
    },
  }, null, 2));
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
}
