import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSelectedRepository,
  listWorkspaceRepositoryAnalyses,
} from "../src/server/repository-analysis.mjs";

class FakeDb {
  constructor() {
    this.workspaces = [{ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" }];
    this.memberships = [{ customerId: "identity-a", workspaceId: "workspace-a" }];
    this.installations = [
      {
        id: "installation-row-1",
        workspace_id: "workspace-a",
        github_installation_id: 123,
        account_login: "kp080681",
        account_type: "User",
      },
    ];
    this.workspaceInstallations = [{ workspaceId: "workspace-a", githubInstallationId: "installation-row-1" }];
    this.repositories = [
      {
        id: "repo-a",
        workspace_id: "workspace-a",
        github_installation_id: "installation-row-1",
        github_repository_id: 9001,
        full_name: "kp080681/dealupwebsite",
        default_branch: "main",
        private: true,
      },
    ];
    this.apps = [];
    this.deployments = [];
    this.buildInputs = [];
    this.envSnapshots = [];
    this.envDetections = [];
    this.envRequirements = [];
    this.events = [];
    this.policies = [];
    this.queries = [];
    this.appSeq = 0;
    this.deploymentSeq = 0;
    this.snapshotSeq = 0;
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
      const workspace = authorized
        ? this.workspaces.find((candidate) => candidate.id === workspaceId)
        : null;
      return { rowCount: workspace ? 1 : 0, rows: workspace ? [workspace] : [] };
    }

    if (text.includes("JOIN workspace_github_installations wgi") && text.includes("r.id = $2")) {
      const [workspaceId, repositoryId] = params;
      const repository = this.repositories.find(
        (row) => row.workspace_id === workspaceId && row.id === repositoryId,
      );
      if (!repository) return { rowCount: 0, rows: [] };
      const mapped = this.workspaceInstallations.some(
        (row) =>
          row.workspaceId === workspaceId &&
          row.githubInstallationId === repository.github_installation_id,
      );
      if (!mapped) return { rowCount: 0, rows: [] };
      const installation = this.installations.find((row) => row.id === repository.github_installation_id);
      return {
        rowCount: 1,
        rows: [{ ...repository, provider_installation_id: installation.github_installation_id }],
      };
    }

    if (text === "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE") {
      const workspace = this.workspaces.find((row) => row.id === params[0]);
      return { rowCount: workspace ? 1 : 0, rows: workspace ? [workspace] : [] };
    }

    if (text.includes("INSERT INTO workspace_resource_policies")) {
      const [workspaceId] = params;
      if (!this.policies.some((row) => row.workspace_id === workspaceId)) {
        this.policies.push({
          workspace_id: workspaceId,
          max_active_apps: 3,
          max_active_deployments: 3,
          max_active_deployments_per_app: 1,
          max_concurrent_provider_operations: 2,
          max_managed_databases: 3,
        });
      }
      return { rowCount: 0, rows: [] };
    }

    if (text.includes("FROM workspace_resource_policies")) {
      const policy = this.policies.find((row) => row.workspace_id === params[0]);
      return { rowCount: policy ? 1 : 0, rows: policy ? [policy] : [] };
    }

    if (text.includes("FROM apps") && text.includes("repository_id = $2")) {
      const [workspaceId, repositoryId] = params;
      const app = this.apps.find(
        (row) => row.workspace_id === workspaceId && row.repository_id === repositoryId && !row.deleted_at,
      );
      return { rowCount: app ? 1 : 0, rows: app ? [app] : [] };
    }

    if (text.includes("FROM apps") && text.includes("slug = $2")) {
      const [workspaceId, slug] = params;
      const app = this.apps.find((row) => row.workspace_id === workspaceId && row.slug === slug);
      return { rowCount: app ? 1 : 0, rows: app ? [app] : [] };
    }

    if (text.includes("FROM apps") && text.includes("count(*)::int AS count")) {
      const [workspaceId] = params;
      const count = this.apps.filter((row) => row.workspace_id === workspaceId && !row.deleted_at).length;
      return { rowCount: 1, rows: [{ count }] };
    }

    if (text.includes("INSERT INTO apps")) {
      const [workspaceId, repositoryId, name, slug, framework, runtime, databaseRequired, databaseMode] = params;
      const app = {
        id: `app-${++this.appSeq}`,
        workspace_id: workspaceId,
        repository_id: repositoryId,
        name,
        slug,
        framework,
        runtime,
        database_required: databaseRequired,
        database_mode: databaseMode,
      };
      this.apps.push(app);
      return { rowCount: 1, rows: [app] };
    }

    if (text.includes("UPDATE apps")) {
      const [name, framework, runtime, databaseRequired, databaseMode, appId] = params;
      const app = this.apps.find((row) => row.id === appId);
      Object.assign(app, { name, framework, runtime, database_required: databaseRequired, database_mode: databaseMode });
      return { rowCount: 1, rows: [app] };
    }

    if (text.includes("FROM deployments") && text.includes("app_id = $1") && text.includes("source_commit_sha = $2")) {
      const [appId, commitSha] = params;
      const deployment = this.deployments.find((row) => row.app_id === appId && row.source_commit_sha === commitSha);
      return { rowCount: deployment ? 1 : 0, rows: deployment ? [deployment] : [] };
    }

    if (text.includes("INSERT INTO deployments")) {
      const [deploymentKey, workspaceId, appId, commitSha, branch] = params;
      const deployment = {
        id: `deployment-${++this.deploymentSeq}`,
        deployment_key: deploymentKey,
        workspace_id: workspaceId,
        app_id: appId,
        source_commit_sha: commitSha,
        source_branch: branch,
        status: "ANALYZING",
        error_code: null,
      };
      this.deployments.push(deployment);
      return { rowCount: 1, rows: [deployment] };
    }

    if (text.includes("INSERT INTO deployment_events")) {
      const [deploymentId, maybeMessage, maybeMetadata] = params;
      const eventTypeMatch = text.match(/,'([^']+)'\s*,/);
      this.events.push({
        deployment_id: deploymentId,
        event_type: eventTypeMatch?.[1] ?? "STATUS_CHANGED",
        message: maybeMessage,
        metadata: maybeMetadata,
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("FROM deployment_events")) {
      const [deploymentId, eventType] = params;
      const event = this.events.find((row) => row.deployment_id === deploymentId && row.event_type === eventType);
      return { rowCount: event ? 1 : 0, rows: event ? [event] : [] };
    }

    if (text.includes("FROM deployment_build_inputs")) {
      const input = this.buildInputs.find((row) => row.deployment_id === params[0]);
      return { rowCount: input ? 1 : 0, rows: input ? [input] : [] };
    }

    if (text.includes("INSERT INTO deployment_build_inputs")) {
      const [deploymentId, repositoryFullName, commitSha, gitTreeSha, rootDirectory, packageManager, lockfile, installCommand, buildCommand, startCommand, manifestSha256, manifest] = params;
      this.buildInputs.push({
        deployment_id: deploymentId,
        repository_full_name: repositoryFullName,
        commit_sha: commitSha,
        git_tree_sha: gitTreeSha,
        root_directory: rootDirectory,
        package_manager: packageManager,
        lockfile,
        install_command: installCommand,
        build_command: buildCommand,
        start_command: startCommand,
        manifest_sha256: manifestSha256,
        manifest: JSON.parse(manifest),
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("FROM deployment_env_detection_snapshots")) {
      const snapshot = this.envSnapshots.find((row) => row.deployment_id === params[0]);
      return { rowCount: snapshot ? 1 : 0, rows: snapshot ? [snapshot] : [] };
    }

    if (text.includes("INSERT INTO deployment_env_detection_snapshots")) {
      const [deploymentId, workspaceId, appId, repositoryFullName, commitSha, gitTreeSha, rootDirectory, detectorVersion, detectedCount, scannedFileCount, skippedFileCount, snapshot] = params;
      const row = {
        id: `snapshot-${++this.snapshotSeq}`,
        deployment_id: deploymentId,
        workspace_id: workspaceId,
        app_id: appId,
        repository_full_name: repositoryFullName,
        commit_sha: commitSha,
        git_tree_sha: gitTreeSha,
        root_directory: rootDirectory,
        detector_version: detectorVersion,
        detected_count: detectedCount,
        scanned_file_count: scannedFileCount,
        skipped_file_count: skippedFileCount,
        snapshot: JSON.parse(snapshot),
      };
      this.envSnapshots.push(row);
      return { rowCount: 1, rows: [{ id: row.id }] };
    }

    if (text.includes("INSERT INTO deployment_env_requirement_detections")) {
      const [, deploymentId, workspaceId, appId, envKey, referenceKind, requiredInference, isPublic, sources] = params;
      this.envDetections.push({
        deployment_id: deploymentId,
        workspace_id: workspaceId,
        app_id: appId,
        env_key: envKey,
        reference_kind: referenceKind,
        required_inference: requiredInference,
        public: isPublic,
        sources: JSON.parse(sources),
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("INSERT INTO app_env_requirements")) {
      const [workspaceId, appId, envKey, source, required, isPublic] = params;
      let row = this.envRequirements.find((item) => item.app_id === appId && item.env_key === envKey);
      if (!row) {
        row = { workspace_id: workspaceId, app_id: appId, env_key: envKey, source, required, public: isPublic };
        this.envRequirements.push(row);
      } else {
        row.public = row.public || isPublic;
      }
      return { rowCount: 1, rows: [] };
    }

    if (text.includes("UPDATE deployments")) {
      const deployment = this.deployments.find((row) => row.id === params.at(-1));
      if (deployment) {
        if (text.includes("error_code = NULL")) deployment.error_code = null;
        if (text.includes("error_code = $1")) deployment.error_code = params[0];
      }
      return { rowCount: deployment ? 1 : 0, rows: deployment ? [{ id: deployment.id }] : [] };
    }

    if (text.includes("FROM github_repositories r") && text.includes("LEFT JOIN LATERAL")) {
      const [workspaceId] = params;
      const rows = this.repositories
        .filter((repository) => repository.workspace_id === workspaceId)
        .map((repository) => {
          const app = this.apps.find((item) => item.workspace_id === workspaceId && item.repository_id === repository.id && !item.deleted_at);
          const deployment = app
            ? this.deployments.filter((item) => item.app_id === app.id).at(-1)
            : null;
          const buildInput = deployment
            ? this.buildInputs.find((item) => item.deployment_id === deployment.id)
            : null;
          const envKeys = deployment
            ? this.envDetections.filter((item) => item.deployment_id === deployment.id).map((item) => item.env_key).sort()
            : [];
          return {
            repository_id: repository.id,
            repository_full_name: repository.full_name,
            default_branch: repository.default_branch,
            app_id: app?.id ?? null,
            database_required: app?.database_required ?? false,
            database_mode: app?.database_mode ?? null,
            deployment_id: deployment?.id ?? null,
            parent_deployment_id: deployment?.parent_deployment_id ?? null,
            source_commit_sha: deployment?.source_commit_sha ?? null,
            source_branch: deployment?.source_branch ?? null,
            status: deployment?.status ?? null,
            error_code: deployment?.error_code ?? null,
            orchestrator_run_id: deployment?.orchestrator_run_id ?? null,
            live_url: deployment?.live_url ?? null,
            package_manager: buildInput?.package_manager ?? null,
            install_command: buildInput?.install_command ?? null,
            build_command: buildInput?.build_command ?? null,
            start_command: buildInput?.start_command ?? null,
            framework: buildInput?.manifest?.framework ?? null,
            runtime: buildInput?.manifest?.runtime ?? null,
            env_keys: envKeys,
          };
        });
      return { rowCount: rows.length, rows };
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
}

function fakeGitHubClient({ commitSha = "a".repeat(40), packageJson = null, rootFiles = ["package.json", "package-lock.json"], sourceFiles = {} } = {}) {
  const files = new Map(Object.entries(sourceFiles));
  const packageContent = packageJson
    ? Buffer.from(JSON.stringify(packageJson), "utf8").toString("base64")
    : null;
  return {
    git: {
      getRef: async () => ({ data: { object: { sha: commitSha } } }),
      getCommit: async () => ({ data: { tree: { sha: "b".repeat(40) } } }),
      getTree: async () => ({
        data: {
          truncated: false,
          tree: [...files.keys()].map((path, index) => ({ type: "blob", path, sha: `file-${index}` })),
        },
      }),
      getBlob: async ({ file_sha: fileSha }) => {
        const index = Number(String(fileSha).split("-").at(1));
        const content = [...files.values()][index];
        return { data: { encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") } };
      },
    },
    repos: {
      getContent: async ({ path }) => {
        if (path === "") {
          return {
            data: rootFiles.map((name) => ({
              name,
              type: name === "package.json" ? "file" : "file",
            })),
          };
        }
        if (path === "package.json" && packageContent) {
          return { data: { type: "file", content: packageContent } };
        }
        return { data: { type: "file", content: "" } };
      },
    },
  };
}

const nextPackage = {
  name: "dealupwebsite",
  version: "1.0.0",
  scripts: { build: "next build", start: "next start" },
  dependencies: { next: "16.0.0", react: "19.0.0" },
};

test("repository analysis resolves commit server-side and persists safe deployment-scoped analysis", async () => {
  const db = new FakeDb();
  const analysis = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_test",
    createInstallationClient: async () =>
      fakeGitHubClient({
        packageJson: nextPackage,
        sourceFiles: {
          "app/page.js": "export default function Page(){ return process.env.NEXT_PUBLIC_SITE_URL }",
          "app/api/route.js": "const token = process.env.SECRET_TOKEN;",
        },
      }),
  });

  assert.equal(analysis.result, "REPOSITORY_ANALYSIS_READY");
  assert.equal(analysis.commitSha, "a".repeat(40));
  assert.equal(analysis.framework, "nextjs");
  assert.equal(analysis.runtime, "nodejs");
  assert.equal(analysis.packageManager, "npm");
  assert.equal(analysis.databaseRequired, false);
  assert.deepEqual(analysis.envRequirementNames, ["NEXT_PUBLIC_SITE_URL", "SECRET_TOKEN"]);
  assert.equal(db.apps.length, 1);
  assert.equal(db.deployments.length, 1);
  assert.equal(db.buildInputs.length, 1);
  assert.equal(db.envSnapshots.length, 1);
  assert.equal(db.envRequirements.some((row) => row.required), true);
  assert.equal(JSON.stringify(analysis).includes("secret-value"), false);
});

test("same commit analysis is idempotent and refresh read returns persisted analysis", async () => {
  const db = new FakeDb();
  const createInstallationClient = async () =>
    fakeGitHubClient({ packageJson: nextPackage, sourceFiles: { "app/page.js": "process.env.NEXT_PUBLIC_SITE_URL" } });

  const first = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_same",
    createInstallationClient,
  });
  const second = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_duplicate",
    createInstallationClient,
  });
  const persisted = await listWorkspaceRepositoryAnalyses(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
  });

  assert.equal(first.appId, second.appId);
  assert.equal(first.deploymentId, second.deploymentId);
  assert.equal(db.apps.length, 1);
  assert.equal(db.deployments.length, 1);
  assert.equal(db.buildInputs.length, 1);
  assert.equal(persisted[0].supported, true);
  assert.deepEqual(persisted[0].envRequirementNames, ["NEXT_PUBLIC_SITE_URL"]);
  assert.equal(persisted[0].currentDeployment.deploymentId, first.deploymentId);
  assert.equal(persisted[0].currentDeployment.status, "ANALYZING");
  assert.equal(persisted[0].currentDeployment.active, false);
});

test("refresh analysis returns latest active redeployment instead of older live deployment", async () => {
  const db = new FakeDb();
  db.apps.push({
    id: "app-existing",
    workspace_id: "workspace-a",
    repository_id: "repo-a",
    name: "dealupwebsite",
    slug: "dealupwebsite",
    framework: "nextjs",
    runtime: "nodejs",
    database_required: false,
    database_mode: "NONE",
  });
  db.deployments.push({
    id: "deployment-live",
    workspace_id: "workspace-a",
    app_id: "app-existing",
    source_commit_sha: "a".repeat(40),
    source_branch: "main",
    status: "LIVE",
    error_code: null,
    parent_deployment_id: null,
    orchestrator_run_id: "run-live",
    live_url: "https://old-live.example",
    created_at: 1,
  });
  db.deployments.push({
    id: "deployment-active",
    workspace_id: "workspace-a",
    app_id: "app-existing",
    source_commit_sha: "b".repeat(40),
    source_branch: "main",
    status: "BUILDING",
    error_code: null,
    parent_deployment_id: "deployment-live",
    orchestrator_run_id: "run-active",
    live_url: null,
    created_at: 2,
  });
  db.buildInputs.push({
    deployment_id: "deployment-active",
    package_manager: "npm",
    install_command: "npm ci",
    build_command: "npm run build",
    start_command: "npm run start",
    manifest: { framework: "nextjs", runtime: "nodejs" },
  });

  const [analysis] = await listWorkspaceRepositoryAnalyses(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
  });

  assert.equal(analysis.deploymentId, "deployment-active");
  assert.equal(analysis.currentDeployment.deploymentId, "deployment-active");
  assert.equal(analysis.currentDeployment.parentDeploymentId, "deployment-live");
  assert.equal(analysis.currentDeployment.status, "BUILDING");
  assert.equal(analysis.currentDeployment.stage, "Building your app");
  assert.equal(analysis.currentDeployment.active, true);
  assert.equal(analysis.currentDeployment.terminal, false);
  assert.equal(analysis.currentDeployment.liveUrl, null);
});

for (const status of ["ANALYZING", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING"]) {
  test(`refresh analysis marks ${status} deployment active when orchestration has started`, async () => {
    const db = new FakeDb();
    const analysis = await analyzeSelectedRepository(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      deploymentKeyFactory: () => `dep_${status.toLowerCase()}`,
      createInstallationClient: async () =>
        fakeGitHubClient({ packageJson: nextPackage, sourceFiles: { "app/page.js": "" } }),
    });
    const deployment = db.deployments.find((row) => row.id === analysis.deploymentId);
    deployment.status = status;
    deployment.orchestrator_run_id = `run-${status}`;

    const [persisted] = await listWorkspaceRepositoryAnalyses(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
    });

    assert.equal(persisted.currentDeployment.status, status);
    assert.equal(persisted.currentDeployment.active, true);
    assert.equal(persisted.currentDeployment.terminal, false);
  });
}

for (const status of ["LIVE", "FAILED"]) {
  test(`refresh analysis marks ${status} deployment terminal and inactive`, async () => {
    const db = new FakeDb();
    const analysis = await analyzeSelectedRepository(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      repositoryId: "repo-a",
      deploymentKeyFactory: () => `dep_${status.toLowerCase()}`,
      createInstallationClient: async () =>
        fakeGitHubClient({ packageJson: nextPackage, sourceFiles: { "app/page.js": "" } }),
    });
    const deployment = db.deployments.find((row) => row.id === analysis.deploymentId);
    deployment.status = status;
    deployment.orchestrator_run_id = `run-${status}`;
    deployment.live_url = status === "LIVE" ? "https://app.example" : null;
    deployment.error_code = status === "FAILED" ? "HEALTH_CHECK_FAILED" : null;

    const [persisted] = await listWorkspaceRepositoryAnalyses(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
    });

    assert.equal(persisted.currentDeployment.status, status);
    assert.equal(persisted.currentDeployment.active, false);
    assert.equal(persisted.currentDeployment.terminal, true);
    assert.equal(persisted.currentDeployment.liveUrl, status === "LIVE" ? "https://app.example" : null);
  });
}

test("changed branch head creates a distinct immutable analysis deployment without duplicating app", async () => {
  const db = new FakeDb();
  const source = (commitSha) => async () =>
    fakeGitHubClient({ commitSha, packageJson: nextPackage, sourceFiles: { "app/page.js": "" } });

  const first = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_first",
    createInstallationClient: source("a".repeat(40)),
  });
  const second = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_second",
    createInstallationClient: source("c".repeat(40)),
  });

  assert.equal(first.appId, second.appId);
  assert.notEqual(first.deploymentId, second.deploymentId);
  assert.equal(db.apps.length, 1);
  assert.equal(db.deployments.length, 2);
});

test("cross-workspace and unmapped repository analysis fail closed", async () => {
  const db = new FakeDb();
  await assert.rejects(
    () =>
      analyzeSelectedRepository(db, {
        customerId: "identity-a",
        workspaceId: "workspace-b",
        repositoryId: "repo-a",
        createInstallationClient: async () => fakeGitHubClient({ packageJson: nextPackage }),
      }),
    /Workspace not found/,
  );

  db.memberships.push({ customerId: "identity-a", workspaceId: "workspace-b" });
  await assert.rejects(
    () =>
      analyzeSelectedRepository(db, {
        customerId: "identity-a",
        workspaceId: "workspace-b",
        repositoryId: "repo-a",
        createInstallationClient: async () => fakeGitHubClient({ packageJson: nextPackage }),
      }),
    /Selected repository is not available/,
  );
});

test("installation mapping is required even when a repository row exists", async () => {
  const db = new FakeDb();
  db.workspaceInstallations = [];

  await assert.rejects(
    () =>
      analyzeSelectedRepository(db, {
        customerId: "identity-a",
        workspaceId: "workspace-a",
        repositoryId: "repo-a",
        createInstallationClient: async () => fakeGitHubClient({ packageJson: nextPackage }),
      }),
    /Selected repository is not available/,
  );
});

test("browser-supplied analysis metadata cannot override server-derived source identity", async () => {
  const db = new FakeDb();
  const analysis = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    commitSha: "browser-commit-is-ignored",
    framework: "browser-framework-is-ignored",
    deploymentKeyFactory: () => "dep_server",
    createInstallationClient: async () =>
      fakeGitHubClient({ packageJson: nextPackage, sourceFiles: { "app/page.js": "" } }),
  });

  assert.equal(analysis.commitSha, "a".repeat(40));
  assert.equal(analysis.framework, "nextjs");
});

test("unsupported repository is persisted as safe analysis state", async () => {
  const db = new FakeDb();
  const analysis = await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_unsupported",
    createInstallationClient: async () =>
      fakeGitHubClient({ rootFiles: ["README.md"], packageJson: null, sourceFiles: {} }),
  });

  assert.equal(analysis.result, "REPOSITORY_ANALYSIS_UNSUPPORTED");
  assert.equal(analysis.supported, false);
  assert.equal(analysis.errorCode, "PACKAGE_JSON_NOT_FOUND");
  assert.equal(db.apps.length, 1);
  assert.equal(db.deployments[0].error_code, "PACKAGE_JSON_NOT_FOUND");
});

test("repository analysis does not invoke provider deployment or provisioning paths", async () => {
  const db = new FakeDb();
  await analyzeSelectedRepository(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
    deploymentKeyFactory: () => "dep_no_provider",
    createInstallationClient: async () =>
      fakeGitHubClient({ packageJson: nextPackage, sourceFiles: { "app/page.js": "" } }),
  });

  const sql = db.queries.map((query) => query.text).join("\n");
  assert.equal(sql.includes("app_runtimes"), false);
  assert.equal(sql.includes("deployment_builds"), false);
  assert.equal(sql.includes("deployment_provider_operations"), false);
  assert.equal(sql.includes("deployment_health_checks"), false);
});
