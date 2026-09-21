import assert from "node:assert/strict";
import test from "node:test";
import {
  getDeploymentReadiness,
  listWorkspaceConfigurationStatuses,
  saveCustomerAppSecret,
} from "../src/server/customer-configuration.mjs";

class FakeDb {
  constructor() {
    this.workspaces = [{ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" }];
    this.memberships = [{ customerId: "identity-a", workspaceId: "workspace-a" }];
    this.apps = [
      {
        id: "app-a",
        workspace_id: "workspace-a",
        repository_id: "repo-a",
        name: "App A",
        slug: "app-a",
        framework: "nextjs",
        runtime: "nodejs",
        database_required: false,
        database_mode: "NONE",
        deleted_at: null,
        created_at: 1,
      },
    ];
    this.deployments = [
      {
        id: "deployment-a",
        app_id: "app-a",
        status: "ANALYZING",
        error_code: null,
        source_commit_sha: "a".repeat(40),
        source_branch: "main",
        created_at: 1,
      },
    ];
    this.buildInputs = [{ id: "build-input-a", deployment_id: "deployment-a" }];
    this.requirements = [];
    this.detections = [];
    this.secrets = [];
    this.bindings = [];
    this.queries = [];
    this.secretSeq = 0;
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    this.queries.push({ text, params });

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rowCount: 0, rows: [] };

    if (
      text.includes("FROM customer_workspace_memberships cwm") &&
      text.includes("AND w.id = $2")
    ) {
      const [customerId, workspaceId] = params;
      const authorized = this.memberships.some(
        (membership) => membership.customerId === customerId && membership.workspaceId === workspaceId,
      );
      const workspace = authorized ? this.workspaces.find((row) => row.id === workspaceId) : null;
      return { rowCount: workspace ? 1 : 0, rows: workspace ? [workspace] : [] };
    }

    if (text.includes("FROM apps") && text.includes("AND id = $2")) {
      const [workspaceId, appId] = params;
      const app = this.apps.find((row) => row.workspace_id === workspaceId && row.id === appId);
      return { rowCount: app ? 1 : 0, rows: app ? [app] : [] };
    }

    if (text.includes("FROM apps") && text.includes("deleted_at IS NULL") && !text.includes("AND id = $2")) {
      const [workspaceId] = params;
      const rows = this.apps
        .filter((row) => row.workspace_id === workspaceId && !row.deleted_at)
        .sort((a, b) => b.created_at - a.created_at)
        .map((row) => ({ id: row.id }));
      return { rowCount: rows.length, rows };
    }

    if (text.includes("FROM deployments d") && text.includes("LEFT JOIN deployment_build_inputs")) {
      const [appId] = params;
      const deployment = this.deployments
        .filter((row) => row.app_id === appId)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!deployment) return { rowCount: 0, rows: [] };
      const input = this.buildInputs.find((row) => row.deployment_id === deployment.id);
      return { rowCount: 1, rows: [{ ...deployment, build_input_id: input?.id ?? null }] };
    }

    if (text.includes("FROM app_env_requirements r")) {
      const [appId] = params;
      const rows = this.requirements
        .filter((row) => row.app_id === appId)
        .sort((a, b) => a.env_key.localeCompare(b.env_key))
        .map((row) => {
          const binding = this.bindings.find(
            (item) =>
              item.app_id === appId &&
              item.env_key === row.env_key &&
              item.target_environment === "production",
          );
          const secret = binding ? this.secrets.find((item) => item.id === binding.secret_id) : null;
          return {
            ...row,
            configured: Boolean(binding),
            binding_updated_at: binding?.updated_at ?? null,
            secret_updated_at: secret?.updated_at ?? null,
          };
        });
      return { rowCount: rows.length, rows };
    }

    if (text.includes("FROM deployment_env_requirement_detections det")) {
      const [deploymentId] = params;
      const rows = this.detections
        .filter((row) => row.deployment_id === deploymentId)
        .sort((a, b) => a.env_key.localeCompare(b.env_key));
      return { rowCount: rows.length, rows };
    }

    if (text.includes("FROM app_env_requirements") && text.includes("env_key = $2")) {
      const [appId, envKey] = params;
      const requirement = this.requirements.find((row) => row.app_id === appId && row.env_key === envKey);
      return { rowCount: requirement ? 1 : 0, rows: requirement ? [requirement] : [] };
    }

    if (text.includes("INSERT INTO app_secret_bindings")) {
      const [workspaceId, appId, envKey, secretId, targetEnvironment] = params;
      let binding = this.bindings.find(
        (row) => row.app_id === appId && row.env_key === envKey && row.target_environment === targetEnvironment,
      );
      if (!binding) {
        binding = {
          id: `binding-${this.bindings.length + 1}`,
          workspace_id: workspaceId,
          app_id: appId,
          env_key: envKey,
          secret_id: secretId,
          target_environment: targetEnvironment,
          updated_at: new Date("2026-09-10T00:00:00.000Z"),
        };
        this.bindings.push(binding);
      } else {
        binding.secret_id = secretId;
        binding.updated_at = new Date("2026-09-10T00:01:00.000Z");
      }
      return { rowCount: 1, rows: [binding] };
    }

    if (text.startsWith("INSERT INTO workspace_rate_limit_counters")) {
      const [workspaceId, action, windowStart] = params;
      this.rateLimitCounters ??= new Map();
      const key = `${workspaceId}:${action}:${windowStart}`;
      const next = (this.rateLimitCounters.get(key) ?? 0) + 1;
      this.rateLimitCounters.set(key, next);
      return { rowCount: 1, rows: [{ count: next }] };
    }

    throw new Error(`Unhandled fake query: ${text}`);
  }

  async fakeEncrypt(_db, { workspaceId, appId, name, plaintext }) {
    assert.equal(typeof plaintext, "string");
    const secret = {
      id: `secret-${++this.secretSeq}`,
      workspace_id: workspaceId,
      app_id: appId,
      name,
      ciphertext: Buffer.from(`ciphertext-${this.secretSeq}`),
      encrypted_data_key: Buffer.from(`key-${this.secretSeq}`),
      updated_at: new Date("2026-09-10T00:00:00.000Z"),
    };
    this.secrets.push(secret);
    return secret;
  }
}

function addRequirement(db, overrides = {}) {
  db.requirements.push({
    id: `requirement-${db.requirements.length + 1}`,
    workspace_id: "workspace-a",
    app_id: "app-a",
    env_key: "API_KEY",
    required: true,
    public: false,
    source: "user-confirmed",
    updated_at: new Date("2026-09-10T00:00:00.000Z"),
    ...overrides,
  });
}

test("required missing environment returns CONFIGURATION_REQUIRED", async () => {
  const db = new FakeDb();
  addRequirement(db);

  const configuration = await getDeploymentReadiness(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
  });

  assert.equal(configuration.readiness, "CONFIGURATION_REQUIRED");
  assert.deepEqual(configuration.missingKeys, ["API_KEY"]);
  assert.equal(JSON.stringify(configuration).includes("ciphertext"), false);
});

test("required configured environment returns READY_TO_DEPLOY and survives refresh", async () => {
  const db = new FakeDb();
  addRequirement(db);
  const saved = await saveCustomerAppSecret(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    envKey: "API_KEY",
    plaintext: "super-secret-value",
    encryptSecret: db.fakeEncrypt.bind(db),
  });
  const refreshed = await getDeploymentReadiness(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
  });

  assert.equal(saved.configured, true);
  assert.equal(refreshed.readiness, "READY_TO_DEPLOY");
  assert.equal(refreshed.requirements[0].configured, true);
  assert.equal(JSON.stringify(saved).includes("super-secret-value"), false);
  assert.equal(JSON.stringify(refreshed).includes("super-secret-value"), false);
});

test("observed optional environment reference does not block readiness", async () => {
  const db = new FakeDb();
  addRequirement(db, {
    env_key: "NEXT_PUBLIC_SITE_URL",
    required: false,
    public: true,
    source: "source-detection",
  });

  const configuration = await getDeploymentReadiness(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
  });

  assert.equal(configuration.readiness, "READY_TO_DEPLOY");
  assert.deepEqual(configuration.missingKeys, []);
  assert.equal(configuration.requirements[0].public, true);
});

test("managed DATABASE_URL does not block customer readiness", async () => {
  const db = new FakeDb();
  db.apps[0].database_required = true;
  db.apps[0].database_mode = "SSC_MANAGED";
  addRequirement(db, {
    env_key: "DATABASE_URL",
    required: true,
    source: "managed-database",
  });

  const configuration = await getDeploymentReadiness(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
  });

  assert.equal(configuration.readiness, "READY_TO_DEPLOY");
  assert.equal(configuration.requirements[0].managed, true);
  assert.equal(configuration.requirements[0].configured, true);
});

test("workspace configuration list returns customer-safe status for selected apps", async () => {
  const db = new FakeDb();
  addRequirement(db, { required: false, source: "source-detection" });

  const statuses = await listWorkspaceConfigurationStatuses(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
  });

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].appId, "app-a");
  assert.equal(statuses[0].readiness, "READY_TO_DEPLOY");
});

test("cross-workspace app secret write is denied", async () => {
  const db = new FakeDb();
  addRequirement(db);

  await assert.rejects(
    () =>
      saveCustomerAppSecret(db, {
        customerId: "identity-a",
        workspaceId: "workspace-b",
        appId: "app-a",
        envKey: "API_KEY",
        plaintext: "secret",
        encryptSecret: db.fakeEncrypt.bind(db),
      }),
    /Workspace not found/,
  );
});

test("app must belong to authorized workspace and deleted app cannot receive secrets", async () => {
  const db = new FakeDb();
  addRequirement(db);
  db.apps[0].deleted_at = new Date("2026-09-10T00:00:00.000Z");

  await assert.rejects(
    () =>
      saveCustomerAppSecret(db, {
        customerId: "identity-a",
        workspaceId: "workspace-a",
        appId: "app-a",
        envKey: "API_KEY",
        plaintext: "secret",
        encryptSecret: db.fakeEncrypt.bind(db),
      }),
    /Application not found/,
  );
});

test("unknown or platform-managed env keys are rejected", async () => {
  const db = new FakeDb();

  await assert.rejects(
    () =>
      saveCustomerAppSecret(db, {
        customerId: "identity-a",
        workspaceId: "workspace-a",
        appId: "app-a",
        envKey: "UNAPPROVED_KEY",
        plaintext: "secret",
        encryptSecret: db.fakeEncrypt.bind(db),
      }),
    /Environment key is not approved/,
  );

  db.apps[0].database_required = true;
  db.apps[0].database_mode = "SSC_MANAGED";
  addRequirement(db, { env_key: "DATABASE_URL", source: "managed-database" });
  await assert.rejects(
    () =>
      saveCustomerAppSecret(db, {
        customerId: "identity-a",
        workspaceId: "workspace-a",
        appId: "app-a",
        envKey: "DATABASE_URL",
        plaintext: "secret",
        encryptSecret: db.fakeEncrypt.bind(db),
      }),
    /Environment key is managed by Utplava/,
  );
});

test("replacement of the same secret is idempotent without duplicate binding", async () => {
  const db = new FakeDb();
  addRequirement(db);

  await saveCustomerAppSecret(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    envKey: "API_KEY",
    plaintext: "first-secret",
    encryptSecret: db.fakeEncrypt.bind(db),
  });
  await saveCustomerAppSecret(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    envKey: "API_KEY",
    plaintext: "second-secret",
    encryptSecret: db.fakeEncrypt.bind(db),
  });

  assert.equal(db.bindings.length, 1);
  assert.equal(db.bindings[0].secret_id, "secret-2");
  assert.equal(db.secrets.length, 2);
  assert.equal(JSON.stringify(db.secrets).includes("first-secret"), false);
  assert.equal(JSON.stringify(db.secrets).includes("second-secret"), false);
});

test("configuration APIs do not expose ciphertext or KMS metadata fields", async () => {
  const db = new FakeDb();
  addRequirement(db);
  const saved = await saveCustomerAppSecret(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    envKey: "API_KEY",
    plaintext: "secret",
    encryptSecret: db.fakeEncrypt.bind(db),
  });
  const serialized = JSON.stringify(saved);

  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("encrypted_data_key"), false);
  assert.equal(serialized.includes("kms_key_id"), false);
  assert.equal(serialized.includes("encryption_context"), false);
});

test("configuration paths do not invoke provider deployment or provisioning tables", async () => {
  const db = new FakeDb();
  addRequirement(db);
  await saveCustomerAppSecret(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    envKey: "API_KEY",
    plaintext: "secret",
    encryptSecret: db.fakeEncrypt.bind(db),
  });

  const sql = db.queries.map((query) => query.text).join("\n");
  assert.equal(sql.includes("deployment_provider_operations"), false);
  assert.equal(sql.includes("deployment_builds b"), false);
  assert.equal(sql.includes("app_runtimes"), false);
  assert.equal(sql.includes("deployment_health_checks"), false);
});
