import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import pg from "pg";
import { requireWorkspaceId } from "../src/operator-targeting.mjs";

for (const name of ["DATABASE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "CONTROL_PLANE_WORKSPACE_ID", "CONTROL_PLANE_REPOSITORY"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const repositoryFullName = process.env.CONTROL_PLANE_REPOSITORY;
const workspaceId = requireWorkspaceId();
const [owner, repo] = repositoryFullName.split("/");
if (!owner || !repo) throw new Error("CONTROL_PLANE_REPOSITORY must be owner/repo");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const installationRows = await db.query(
    `SELECT id, workspace_id, github_installation_id, account_login, account_type
       FROM github_installations
      WHERE workspace_id = $1
        AND lower(account_login)=lower($2)
      ORDER BY created_at ASC`,
    [workspaceId, owner],
  );
  if (installationRows.rowCount === 0) {
    throw new Error(`No GitHub App installation is mapped for workspace ${workspaceId} and account: ${owner}`);
  }

  let matched = null;
  for (const installation of installationRows.rows) {
    try {
      const auth = createAppAuth({
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
      });
      const installationAuth = await auth({
        type: "installation",
        installationId: Number(installation.github_installation_id),
      });
      const octokit = new Octokit({ auth: installationAuth.token });
      const repository = await octokit.repos.get({ owner, repo });
      matched = { installation, repository: repository.data };
      break;
    } catch (error) {
      if (error?.status === 404 || error?.status === 403) continue;
      throw error;
    }
  }

  if (!matched) {
    throw new Error(`GitHub App installation cannot access repository: ${repositoryFullName}. Add the repository to the SSC GitHub App installation and retry.`);
  }

  const { installation, repository } = matched;
  const saved = await db.query(
    `INSERT INTO github_repositories
       (workspace_id, github_installation_id, github_repository_id, full_name, default_branch, private)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, full_name) DO UPDATE SET
       github_installation_id=EXCLUDED.github_installation_id,
       github_repository_id=EXCLUDED.github_repository_id,
       default_branch=EXCLUDED.default_branch,
       private=EXCLUDED.private,
       updated_at=now()
     RETURNING id, workspace_id, github_installation_id, github_repository_id, full_name, default_branch, private`,
    [
      installation.workspace_id,
      installation.id,
      repository.id,
      repository.full_name,
      repository.default_branch || "main",
      Boolean(repository.private),
    ],
  );

  const refAuth = createAppAuth({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
  const installationAuth = await refAuth({
    type: "installation",
    installationId: Number(installation.github_installation_id),
  });
  const octokit = new Octokit({ auth: installationAuth.token });
  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${repository.default_branch || "main"}` });

  console.log(JSON.stringify({
    result: "GITHUB_REPOSITORY_MAPPED",
    repository: saved.rows[0].full_name,
    repositoryId: String(saved.rows[0].github_repository_id),
    workspaceId: saved.rows[0].workspace_id,
    defaultBranch: saved.rows[0].default_branch,
    private: saved.rows[0].private,
    commitSha: ref.data.object.sha,
    installationAccessVerified: true,
    installationTokenPrinted: false,
    privateKeyPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
