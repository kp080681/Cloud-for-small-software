import { getAuthorizedWorkspace } from "./customer-workspaces.mjs";
import {
  findRepositoryById,
  getGitHubInstallation,
  listInstallationRepositories,
  safeGitHubRepository,
} from "./github-app.mjs";

export function parseInstallationId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error("GitHub installation id is invalid."), {
      status: 400,
      code: "INVALID_GITHUB_INSTALLATION",
    });
  }
  return id;
}

export async function listWorkspaceGitHubInstallations(db, { customerId, workspaceId }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const result = await db.query(
    `
      SELECT id, github_installation_id, account_login, account_type
      FROM github_installations
      WHERE workspace_id = $1
      ORDER BY created_at ASC
    `,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    githubInstallationId: String(row.github_installation_id),
    accountLogin: row.account_login,
    accountType: row.account_type,
  }));
}

export async function listSelectedWorkspaceRepositories(db, { customerId, workspaceId }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const result = await db.query(
    `
      SELECT id, github_repository_id, full_name, default_branch, private
      FROM github_repositories
      WHERE workspace_id = $1
      ORDER BY full_name ASC
    `,
    [workspaceId],
  );
  return result.rows.map(safeStoredRepository);
}

export async function connectGitHubInstallationToWorkspace(
  db,
  {
    customerId,
    workspaceId,
    installationId,
    getInstallation = getGitHubInstallation,
  },
) {
  const parsedInstallationId = parseInstallationId(installationId);
  await db.query("BEGIN");
  try {
    await getAuthorizedWorkspace(db, { customerId, workspaceId });
    const existing = await db.query(
      `
        SELECT id, workspace_id
        FROM github_installations
        WHERE github_installation_id = $1
        FOR UPDATE
      `,
      [parsedInstallationId],
    );

    if (existing.rows[0] && existing.rows[0].workspace_id !== workspaceId) {
      throw Object.assign(new Error("GitHub installation already belongs to another workspace."), {
        status: 409,
        code: "GITHUB_INSTALLATION_ALREADY_CONNECTED",
      });
    }

    const installation = await getInstallation({ installationId: parsedInstallationId });
    const account = installation.account ?? {};
    const saved = await db.query(
      `
        INSERT INTO github_installations
          (workspace_id, github_installation_id, account_login, account_type)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (github_installation_id)
        DO UPDATE SET
          account_login = EXCLUDED.account_login,
          account_type = EXCLUDED.account_type,
          updated_at = now()
        RETURNING id, workspace_id, github_installation_id, account_login, account_type
      `,
      [
        workspaceId,
        parsedInstallationId,
        account.login ?? "unknown",
        account.type ?? null,
      ],
    );

    if (saved.rows[0].workspace_id !== workspaceId) {
      throw Object.assign(new Error("GitHub installation workspace mapping changed unexpectedly."), {
        status: 409,
        code: "GITHUB_INSTALLATION_WORKSPACE_MISMATCH",
      });
    }

    await db.query("COMMIT");
    return {
      id: saved.rows[0].id,
      githubInstallationId: String(saved.rows[0].github_installation_id),
      accountLogin: saved.rows[0].account_login,
      accountType: saved.rows[0].account_type,
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function listWorkspaceInstallationRepositories(
  db,
  {
    customerId,
    workspaceId,
    listRepositories = listInstallationRepositories,
  },
) {
  const installations = await listWorkspaceGitHubInstallations(db, { customerId, workspaceId });
  const selected = await listSelectedWorkspaceRepositories(db, { customerId, workspaceId });
  const selectedIds = new Set(selected.map((repository) => repository.githubRepositoryId));
  const repositoryGroups = [];

  for (const installation of installations) {
    try {
      const repositories = await listRepositories({
        installationId: Number(installation.githubInstallationId),
      });
      repositoryGroups.push({
        installation,
        repositories: repositories.map((repository) => ({
          ...repository,
          selected: selectedIds.has(repository.githubRepositoryId),
        })),
      });
    } catch {
      repositoryGroups.push({
        installation,
        error: "GITHUB_ACCESS_NEEDS_RECONNECT",
        repositories: [],
      });
    }
  }

  return {
    connectionStatus: installations.length > 0 ? "CONNECTED" : "NOT_CONNECTED",
    installations: repositoryGroups,
    selectedRepositories: selected,
  };
}

export async function selectWorkspaceRepository(
  db,
  {
    customerId,
    workspaceId,
    installationId,
    repositoryId,
    listRepositories = listInstallationRepositories,
  },
) {
  const parsedInstallationId = parseInstallationId(installationId);
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const installation = await db.query(
    `
      SELECT id, workspace_id, github_installation_id
      FROM github_installations
      WHERE workspace_id = $1
        AND github_installation_id = $2
      LIMIT 1
    `,
    [workspaceId, parsedInstallationId],
  );
  if (!installation.rows[0]) {
    throw Object.assign(new Error("GitHub connection not found."), {
      status: 404,
      code: "GITHUB_CONNECTION_NOT_FOUND",
    });
  }

  const repositories = await listRepositories({ installationId: parsedInstallationId });
  const repository = findRepositoryById(repositories, repositoryId);
  if (!repository) {
    throw Object.assign(new Error("Repository is no longer available to this GitHub installation."), {
      status: 404,
      code: "REPOSITORY_NOT_AVAILABLE",
    });
  }

  const saved = await db.query(
    `
      INSERT INTO github_repositories
        (workspace_id, github_installation_id, github_repository_id, full_name, default_branch, private)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (workspace_id, full_name)
      DO UPDATE SET
        github_installation_id = EXCLUDED.github_installation_id,
        github_repository_id = EXCLUDED.github_repository_id,
        default_branch = EXCLUDED.default_branch,
        private = EXCLUDED.private,
        updated_at = now()
      RETURNING id, github_repository_id, full_name, default_branch, private
    `,
    [
      workspaceId,
      installation.rows[0].id,
      Number(repository.githubRepositoryId),
      repository.fullName,
      repository.defaultBranch,
      repository.private,
    ],
  );
  return safeStoredRepository(saved.rows[0]);
}

export function safeStoredRepository(row) {
  return {
    id: row.id,
    githubRepositoryId: String(row.github_repository_id),
    fullName: row.full_name,
    name: row.full_name?.split("/")?.at(-1) ?? row.full_name,
    ownerLogin: row.full_name?.split("/")?.[0] ?? null,
    defaultBranch: row.default_branch || "main",
    private: Boolean(row.private),
  };
}

export { safeGitHubRepository };
