import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import pg from "pg";

const required = [
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const installationId = Number(process.env.GITHUB_INSTALLATION_ID);
if (!Number.isSafeInteger(installationId) || installationId <= 0) {
  throw new Error("GITHUB_INSTALLATION_ID must be a positive integer");
}

const auth = createAppAuth({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
});

const appAuth = await auth({ type: "app" });
const appOctokit = new Octokit({ auth: appAuth.token });
const installation = await appOctokit.apps.getInstallation({ installation_id: installationId });

const installationAuth = await auth({ type: "installation", installationId });
const octokit = new Octokit({ auth: installationAuth.token });
const repositories = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, { per_page: 100 });

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  await db.query("BEGIN");

  const workspaceName = process.env.CONTROL_PLANE_WORKSPACE_NAME || "Internal Alpha";

  // If the installation is already mapped, its workspace is canonical.
  const existingInstallation = await db.query(
    `SELECT workspace_id
       FROM github_installations
      WHERE github_installation_id = $1
      FOR UPDATE`,
    [installationId],
  );

  let workspace;
  if (existingInstallation.rowCount > 0) {
    const workspaceResult = await db.query(
      `SELECT id, name FROM workspaces WHERE id = $1`,
      [existingInstallation.rows[0].workspace_id],
    );
    workspace = workspaceResult.rows[0];
  } else {
    // Internal bootstrap path: reuse the oldest workspace with this name before creating one.
    const workspaceResult = await db.query(
      `SELECT id, name
         FROM workspaces
        WHERE name = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [workspaceName],
    );

    if (workspaceResult.rowCount > 0) {
      workspace = workspaceResult.rows[0];
    } else {
      const created = await db.query(
        `INSERT INTO workspaces (name)
         VALUES ($1)
         RETURNING id, name`,
        [workspaceName],
      );
      workspace = created.rows[0];
    }
  }

  const account = installation.data.account;
  const installationResult = await db.query(
    `INSERT INTO github_installations
       (workspace_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_installation_id)
     DO UPDATE SET
       account_login = EXCLUDED.account_login,
       account_type = EXCLUDED.account_type,
       updated_at = now()
     RETURNING id, workspace_id`,
    [workspace.id, installationId, account?.login ?? "unknown", account?.type ?? null],
  );
  const installationRowId = installationResult.rows[0].id;

  if (installationResult.rows[0].workspace_id !== workspace.id) {
    throw new Error("GitHub installation workspace mapping changed unexpectedly");
  }

  const synced = [];
  for (const repository of repositories) {
    const result = await db.query(
      `INSERT INTO github_repositories
         (workspace_id, github_installation_id, github_repository_id, full_name, default_branch, private)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (github_installation_id, github_repository_id)
       DO UPDATE SET
         full_name = EXCLUDED.full_name,
         default_branch = EXCLUDED.default_branch,
         private = EXCLUDED.private,
         updated_at = now()
       RETURNING id, workspace_id, full_name, default_branch, private`,
      [workspace.id, installationRowId, repository.id, repository.full_name, repository.default_branch, repository.private],
    );

    if (result.rows[0].workspace_id !== workspace.id) {
      throw new Error(`Repository workspace mapping mismatch: ${repository.full_name}`);
    }
    synced.push(result.rows[0]);
  }

  await db.query("COMMIT");

  console.log(JSON.stringify({
    result: "NODE_04_2_SYNCED",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    installationId,
    installationAccount: account?.login ?? null,
    repositoryCount: synced.length,
    repositories: synced.map(({ full_name, default_branch, private: isPrivate }) => ({
      fullName: full_name,
      defaultBranch: default_branch,
      private: isPrivate,
    })),
    workspaceMappingStable: true,
    appJwtPrinted: false,
    installationTokenPrinted: false,
    privateKeyPrinted: false,
  }, null, 2));
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
}
