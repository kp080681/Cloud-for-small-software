import assert from "node:assert/strict";
import test from "node:test";
import {
  connectGitHubInstallationToWorkspace,
  listWorkspaceInstallationRepositories,
  selectWorkspaceRepository,
} from "../src/server/customer-github.mjs";
import {
  githubInstallCallbackRedirectPath,
  sealGitHubInstallState,
  unsealGitHubInstallState,
} from "../src/server/github-install-state.mjs";

const secret = "0123456789abcdef0123456789abcdef";

class FakeDb {
  constructor() {
    this.workspaces = [{ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" }];
    this.memberships = [{ customerId: "identity-a", workspaceId: "workspace-a" }];
    this.installations = [];
    this.repositories = [];
    this.queries = [];
    this.installationSeq = 0;
    this.repositorySeq = 0;
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    this.queries.push({ text, params });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };

    if (
      text.includes("FROM customer_workspace_memberships cwm") &&
      text.includes("AND w.id = $2")
    ) {
      const [customerId, workspaceId] = params;
      const authorized = this.memberships.some(
        (membership) => membership.customerId === customerId && membership.workspaceId === workspaceId,
      );
      const workspace = authorized
        ? this.workspaces.find((candidate) => candidate.id === workspaceId)
        : null;
      return { rows: workspace ? [workspace] : [] };
    }

    if (text.includes("FROM github_installations") && text.includes("WHERE workspace_id = $1") && !text.includes("github_installation_id = $2")) {
      const [workspaceId] = params;
      return { rows: this.installations.filter((row) => row.workspace_id === workspaceId) };
    }

    if (text.includes("FROM github_repositories") && text.includes("WHERE workspace_id = $1")) {
      const [workspaceId] = params;
      return { rows: this.repositories.filter((row) => row.workspace_id === workspaceId) };
    }

    if (text.includes("WHERE github_installation_id = $1")) {
      const [installationId] = params;
      return {
        rows: this.installations.filter(
          (row) => Number(row.github_installation_id) === Number(installationId),
        ),
      };
    }

    if (text.includes("INSERT INTO github_installations")) {
      const [workspaceId, installationId, accountLogin, accountType] = params;
      let row = this.installations.find(
        (candidate) => Number(candidate.github_installation_id) === Number(installationId),
      );
      if (!row) {
        row = {
          id: `installation-${++this.installationSeq}`,
          workspace_id: workspaceId,
          github_installation_id: installationId,
          account_login: accountLogin,
          account_type: accountType,
        };
        this.installations.push(row);
      } else {
        row.account_login = accountLogin;
        row.account_type = accountType;
      }
      return { rows: [row] };
    }

    if (
      text.includes("FROM github_installations") &&
      text.includes("workspace_id = $1") &&
      text.includes("github_installation_id = $2")
    ) {
      const [workspaceId, installationId] = params;
      return {
        rows: this.installations.filter(
          (row) =>
            row.workspace_id === workspaceId &&
            Number(row.github_installation_id) === Number(installationId),
        ),
      };
    }

    if (text.includes("INSERT INTO github_repositories")) {
      const [workspaceId, installationRowId, githubRepositoryId, fullName, defaultBranch, isPrivate] = params;
      let row = this.repositories.find(
        (candidate) => candidate.workspace_id === workspaceId && candidate.full_name === fullName,
      );
      if (!row) {
        row = {
          id: `repo-${++this.repositorySeq}`,
          workspace_id: workspaceId,
          github_installation_id: installationRowId,
          github_repository_id: githubRepositoryId,
          full_name: fullName,
          default_branch: defaultBranch,
          private: isPrivate,
        };
        this.repositories.push(row);
      } else {
        Object.assign(row, {
          github_installation_id: installationRowId,
          github_repository_id: githubRepositoryId,
          default_branch: defaultBranch,
          private: isPrivate,
        });
      }
      return { rows: [row] };
    }

    throw new Error(`Unhandled fake query: ${text}`);
  }
}

const providerRepository = {
  githubRepositoryId: "9001",
  fullName: "kp080681/dealupwebsite",
  name: "dealupwebsite",
  ownerLogin: "kp080681",
  defaultBranch: "main",
  private: true,
};

test("authenticated non-member cannot connect GitHub for another workspace", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () =>
      connectGitHubInstallationToWorkspace(db, {
        customerId: "identity-a",
        workspaceId: "workspace-b",
        installationId: 123,
        getInstallation: async () => ({ account: { login: "kp080681", type: "User" } }),
      }),
    /Workspace not found/,
  );
});

test("tampered GitHub installation callback state is rejected by sealed state validation", async () => {
  const sealed = await sealGitHubInstallState(
    { state: "expected", customerId: "identity-a", workspaceId: "workspace-a" },
    secret,
  );
  const state = await unsealGitHubInstallState(sealed, secret);
  assert.notEqual("tampered", state.state);
  assert.equal(await unsealGitHubInstallState(`${sealed}x`, secret), null);
});

test("root setup URL handoff preserves GitHub installation callback parameters", () => {
  assert.equal(
    githubInstallCallbackRedirectPath({
      workspace: "workspace-a",
      installation_id: "123",
      setup_action: "install",
      state: "nonce",
    }),
    "/api/github/install/callback?state=nonce&installation_id=123&setup_action=install",
  );
  assert.equal(githubInstallCallbackRedirectPath({ workspace: "workspace-a" }), null);
});

test("OAuth login alone does not grant repository access", async () => {
  const db = new FakeDb();
  const result = await listWorkspaceInstallationRepositories(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    listRepositories: async () => {
      throw new Error("must not fetch repositories without an installation");
    },
  });
  assert.equal(result.connectionStatus, "NOT_CONNECTED");
  assert.deepEqual(result.installations, []);
});

test("repository listing comes from GitHub App installation authority and is workspace scoped", async () => {
  const db = new FakeDb();
  db.installations.push({
    id: "installation-row-1",
    workspace_id: "workspace-a",
    github_installation_id: 123,
    account_login: "kp080681",
    account_type: "User",
  });
  db.repositories.push({
    id: "repo-selected",
    workspace_id: "workspace-a",
    github_repository_id: 9001,
    full_name: "kp080681/dealupwebsite",
    default_branch: "main",
    private: true,
  });

  const calls = [];
  const result = await listWorkspaceInstallationRepositories(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    listRepositories: async ({ installationId }) => {
      calls.push(installationId);
      return [providerRepository];
    },
  });

  assert.deepEqual(calls, [123]);
  assert.equal(result.connectionStatus, "CONNECTED");
  assert.equal(result.installations[0].repositories[0].selected, true);

  await assert.rejects(
    () =>
      listWorkspaceInstallationRepositories(db, {
        customerId: "identity-a",
        workspaceId: "workspace-b",
        listRepositories: async () => [providerRepository],
      }),
    /Workspace not found/,
  );
});

test("provider errors are sanitized in repository listing", async () => {
  const db = new FakeDb();
  db.installations.push({
    id: "installation-row-1",
    workspace_id: "workspace-a",
    github_installation_id: 123,
    account_login: "kp080681",
    account_type: "User",
  });

  const result = await listWorkspaceInstallationRepositories(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    listRepositories: async () => {
      throw new Error("raw provider token failure should not leak");
    },
  });

  assert.equal(result.installations[0].error, "GITHUB_ACCESS_NEEDS_RECONNECT");
  assert.equal(JSON.stringify(result).includes("raw provider"), false);
});

test("arbitrary or inaccessible repository submitted by the browser is rejected", async () => {
  const db = new FakeDb();
  db.installations.push({
    id: "installation-row-1",
    workspace_id: "workspace-a",
    github_installation_id: 123,
    account_login: "kp080681",
    account_type: "User",
  });

  await assert.rejects(
    () =>
      selectWorkspaceRepository(db, {
        customerId: "identity-a",
        workspaceId: "workspace-a",
        installationId: 123,
        repositoryId: "not-accessible",
        listRepositories: async () => [providerRepository],
      }),
    /Repository is no longer available/,
  );
});

test("valid installation repository can be selected idempotently without leaking tokens", async () => {
  const db = new FakeDb();
  db.installations.push({
    id: "installation-row-1",
    workspace_id: "workspace-a",
    github_installation_id: 123,
    account_login: "kp080681",
    account_type: "User",
  });

  const first = await selectWorkspaceRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    installationId: 123,
    repositoryId: "9001",
    listRepositories: async () => [providerRepository],
  });
  const second = await selectWorkspaceRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    installationId: 123,
    repositoryId: "9001",
    listRepositories: async () => [providerRepository],
  });

  assert.equal(first.id, second.id);
  assert.equal(db.repositories.length, 1);
  const serialized = JSON.stringify(second);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("privateKey"), false);
});

test("repeated GitHub installation callback is idempotent for the same workspace", async () => {
  const db = new FakeDb();
  const payload = {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    installationId: 123,
    getInstallation: async () => ({ account: { login: "kp080681", type: "User" } }),
  };

  const first = await connectGitHubInstallationToWorkspace(db, payload);
  const second = await connectGitHubInstallationToWorkspace(db, payload);
  assert.equal(first.id, second.id);
  assert.equal(db.installations.length, 1);
});
