import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureInitialWorkspace,
  getAuthorizedWorkspace,
  listAuthorizedWorkspaces,
  listWorkspaceApplications,
  renameAuthorizedWorkspace,
  upsertCustomerIdentity,
} from "../src/server/customer-workspaces.mjs";

class FakeDb {
  constructor() {
    this.identities = [];
    this.workspaces = [];
    this.memberships = [];
    this.apps = [];
    this.deployments = [];
    this.queries = [];
    this.workspaceSeq = 0;
    this.identitySeq = 0;
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    this.queries.push({ text, params });

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };

    if (text.includes("INSERT INTO customer_identities")) {
      const [provider, providerAccountId, login, displayName, avatarUrl] = params;
      let identity = this.identities.find(
        (candidate) =>
          candidate.provider === provider && candidate.provider_account_id === providerAccountId,
      );
      if (!identity) {
        identity = {
          id: `identity-${++this.identitySeq}`,
          provider,
          provider_account_id: providerAccountId,
          login,
          display_name: displayName,
          avatar_url: avatarUrl,
        };
        this.identities.push(identity);
      } else {
        Object.assign(identity, {
          login,
          display_name: displayName,
          avatar_url: avatarUrl,
        });
      }
      return { rows: [identity] };
    }

    if (
      text.includes("FROM customer_workspace_memberships cwm") &&
      text.includes("ORDER BY cwm.created_at ASC") &&
      text.includes("LIMIT 1")
    ) {
      const [customerId] = params;
      const membership = this.memberships.find((candidate) => candidate.customerId === customerId);
      const workspace = membership
        ? this.workspaces.find((candidate) => candidate.id === membership.workspaceId)
        : null;
      return { rows: workspace ? [workspace] : [] };
    }

    if (text.includes("INSERT INTO workspaces")) {
      const workspace = {
        id: `workspace-${++this.workspaceSeq}`,
        name: params[0],
      };
      this.workspaces.push(workspace);
      return { rows: [workspace] };
    }

    if (text.includes("INSERT INTO customer_workspace_memberships")) {
      const [customerId, workspaceId] = params;
      if (
        !this.memberships.some(
          (candidate) => candidate.customerId === customerId && candidate.workspaceId === workspaceId,
        )
      ) {
        this.memberships.push({ customerId, workspaceId, createdAt: this.memberships.length });
      }
      return { rows: [] };
    }

    if (
      text.includes("FROM customer_workspace_memberships cwm") &&
      text.includes("WHERE cwm.customer_identity_id = $1") &&
      text.includes("AND w.id = $2")
    ) {
      const [customerId, workspaceId] = params;
      const membership = this.memberships.find(
        (candidate) => candidate.customerId === customerId && candidate.workspaceId === workspaceId,
      );
      const workspace = membership
        ? this.workspaces.find((candidate) => candidate.id === workspaceId)
        : null;
      return { rows: workspace ? [workspace] : [] };
    }

    if (
      text.includes("FROM customer_workspace_memberships cwm") &&
      text.includes("ORDER BY cwm.created_at ASC")
    ) {
      const [customerId] = params;
      const workspaceIds = this.memberships
        .filter((candidate) => candidate.customerId === customerId)
        .map((membership) => membership.workspaceId);
      return {
        rows: this.workspaces.filter((workspace) => workspaceIds.includes(workspace.id)),
      };
    }

    if (text.includes("UPDATE workspaces")) {
      const [name, workspaceId] = params;
      const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
      workspace.name = name;
      return { rows: [workspace] };
    }

    if (text.includes("JOIN apps a ON a.workspace_id = cwm.workspace_id")) {
      const [customerId, workspaceId] = params;
      const authorized = this.memberships.some(
        (candidate) => candidate.customerId === customerId && candidate.workspaceId === workspaceId,
      );
      if (!authorized) return { rows: [] };
      return {
        rows: this.apps
          .filter((app) => app.workspace_id === workspaceId && !app.deleted_at)
          .map((app) => {
            const latest = this.deployments
              .filter((deployment) => deployment.app_id === app.id)
              .sort((a, b) => b.created_at - a.created_at)[0];
            return {
              ...app,
              latest_deployment_status: latest?.status ?? null,
              live_url: latest?.live_url ?? null,
            };
          }),
      };
    }

    throw new Error(`Unhandled fake query: ${text}`);
  }
}

test("first login creates exactly one initial workspace and repeated bootstrap is idempotent", async () => {
  const db = new FakeDb();
  const identity = await upsertCustomerIdentity(db, {
    provider: "github",
    providerAccountId: "123",
    login: "founder",
  });

  const first = await ensureInitialWorkspace(db, {
    customerId: identity.id,
    workspaceName: "founder workspace",
  });
  const second = await ensureInitialWorkspace(db, {
    customerId: identity.id,
    workspaceName: "ignored workspace",
  });

  assert.equal(first.id, second.id);
  assert.equal(db.workspaces.length, 1);
  assert.equal(db.memberships.length, 1);
  assert.equal(
    db.queries.some((query) => query.text.includes("pg_advisory_xact_lock(hashtext($1))")),
    true,
  );
});

test("authenticated user can list and read only authorized workspaces", async () => {
  const db = new FakeDb();
  db.workspaces.push({ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" });
  db.memberships.push({ customerId: "identity-a", workspaceId: "workspace-a" });
  db.memberships.push({ customerId: "identity-b", workspaceId: "workspace-b" });

  const workspaces = await listAuthorizedWorkspaces(db, { customerId: "identity-a" });
  assert.deepEqual(workspaces, [{ id: "workspace-a", name: "A" }]);
  assert.deepEqual(await getAuthorizedWorkspace(db, { customerId: "identity-a", workspaceId: "workspace-a" }), {
    id: "workspace-a",
    name: "A",
  });

  await assert.rejects(
    () => getAuthorizedWorkspace(db, { customerId: "identity-a", workspaceId: "workspace-b" }),
    /Workspace not found/,
  );
  await assert.rejects(
    () => getAuthorizedWorkspace(db, { customerId: "identity-a", workspaceId: "forged-workspace-id" }),
    /Workspace not found/,
  );
});

test("workspace rename verifies membership server-side", async () => {
  const db = new FakeDb();
  db.workspaces.push({ id: "workspace-a", name: "Before" });
  db.memberships.push({ customerId: "identity-a", workspaceId: "workspace-a" });

  assert.deepEqual(
    await renameAuthorizedWorkspace(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      name: "After",
    }),
    { id: "workspace-a", name: "After" },
  );

  await assert.rejects(
    () =>
      renameAuthorizedWorkspace(db, {
        customerId: "identity-b",
        workspaceId: "workspace-a",
        name: "Cross tenant",
      }),
    /Workspace not found/,
  );
});

test("application listing is workspace-scoped and returns only customer-safe fields", async () => {
  const db = new FakeDb();
  db.workspaces.push({ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" });
  db.memberships.push({ customerId: "identity-a", workspaceId: "workspace-a" });
  db.apps.push(
    {
      id: "app-a",
      workspace_id: "workspace-a",
      name: "DealUp",
      slug: "dealup",
      framework: "nextjs",
      runtime: "nodejs",
      database_required: false,
      deleted_at: null,
      secret_ciphertext: "must-not-leak",
    },
    {
      id: "app-b",
      workspace_id: "workspace-b",
      name: "Other",
      slug: "other",
      framework: "nextjs",
      runtime: "nodejs",
      database_required: false,
      deleted_at: null,
    },
  );
  db.deployments.push({
    app_id: "app-a",
    status: "LIVE",
    live_url: "https://example.test",
    created_at: 2,
    error_message: "must-not-leak",
  });

  const apps = await listWorkspaceApplications(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
  });

  assert.deepEqual(apps, [
    {
      id: "app-a",
      name: "DealUp",
      slug: "dealup",
      framework: "nextjs",
      runtime: "nodejs",
      databaseRequired: false,
      latestDeploymentStatus: "LIVE",
      liveUrl: "https://example.test",
    },
  ]);
  assert.equal(JSON.stringify(apps).includes("must-not-leak"), false);
});
