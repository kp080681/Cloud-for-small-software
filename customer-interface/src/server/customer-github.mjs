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
      SELECT gi.id, gi.github_installation_id, gi.account_login, gi.account_type
      FROM workspace_github_installations wgi
      JOIN github_installations gi ON gi.id = wgi.github_installation_id
      WHERE wgi.workspace_id = $1
      ORDER BY wgi.created_at ASC
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
    const identity = await loadGitHubCustomerIdentity(db, { customerId });
    const existing = await db.query(
      `
        SELECT id, workspace_id, github_installation_id, account_login, account_type
        FROM github_installations
        WHERE github_installation_id = $1
        FOR UPDATE
      `,
      [parsedInstallationId],
    );

    const installation = await getInstallation({ installationId: parsedInstallationId });
    assertInstallationMatchesCustomerIdentity(installation, identity);
    const account = installation.account ?? {};
    let saved = existing.rows[0];
    if (saved) {
      const updated = await db.query(
        `
          UPDATE github_installations
          SET account_login = $1,
              account_type = $2,
              updated_at = now()
          WHERE id = $3
          RETURNING id, workspace_id, github_installation_id, account_login, account_type
        `,
        [account.login ?? "unknown", account.type ?? null, saved.id],
      );
      saved = updated.rows[0];
    } else {
      const inserted = await db.query(
        `
          INSERT INTO github_installations
            (workspace_id, github_installation_id, account_login, account_type)
          VALUES ($1, $2, $3, $4)
          RETURNING id, workspace_id, github_installation_id, account_login, account_type
        `,
        [
          workspaceId,
          parsedInstallationId,
          account.login ?? "unknown",
          account.type ?? null,
        ],
      );
      saved = inserted.rows[0];
    }

    await db.query(
      `
        INSERT INTO workspace_github_installations (
          workspace_id,
          github_installation_id,
          connected_by_customer_identity_id
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, github_installation_id)
        DO UPDATE SET
          connected_by_customer_identity_id = EXCLUDED.connected_by_customer_identity_id,
          updated_at = now()
      `,
      [workspaceId, saved.id, customerId],
    );

    await db.query("COMMIT");
    return {
      id: saved.id,
      githubInstallationId: String(saved.github_installation_id),
      accountLogin: saved.account_login,
      accountType: saved.account_type,
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
      SELECT gi.id, gi.workspace_id, gi.github_installation_id
      FROM workspace_github_installations wgi
      JOIN github_installations gi ON gi.id = wgi.github_installation_id
      WHERE wgi.workspace_id = $1
        AND gi.github_installation_id = $2
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

export async function loadGitHubCustomerIdentity(db, { customerId }) {
  const result = await db.query(
    `
      SELECT id, provider, provider_account_id, login
      FROM customer_identities
      WHERE id = $1
        AND provider = 'github'
      LIMIT 1
    `,
    [customerId],
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("GitHub customer identity not found."), {
      status: 403,
      code: "GITHUB_CUSTOMER_IDENTITY_REQUIRED",
    });
  }
  return result.rows[0];
}

export function assertInstallationMatchesCustomerIdentity(installation, identity) {
  const account = installation?.account ?? {};
  const accountType = String(account.type ?? "").toLowerCase();
  const accountId = account.id === null || account.id === undefined ? null : String(account.id);
  const identityProviderId = String(identity.provider_account_id);
  if (accountType !== "user" || accountId !== identityProviderId) {
    throw Object.assign(new Error("GitHub installation does not belong to the authenticated customer."), {
      status: 403,
      code: "GITHUB_INSTALLATION_ACCOUNT_MISMATCH",
    });
  }
  return installation;
}

export { safeGitHubRepository };
