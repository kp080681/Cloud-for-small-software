import crypto from "node:crypto";
import { detectProject } from "../shared/control-plane/project-detection.mjs";
import {
  ENV_DETECTOR_VERSION,
  detectEnvReferencesInSource,
  isDetectableSourcePath,
  mergeEnvDetections,
} from "../shared/control-plane/env-requirement-detection.mjs";
import { sourceDetectedRequirement } from "../shared/control-plane/env-requirement-reconciliation.mjs";
import {
  SOURCE_LIMITS,
  assertDetectableSourceFileCount,
  assertTotalSourceBytes,
  assertUniqueRepositoryPaths,
  normalizeRootDirectory,
  relativePathUnderRoot,
} from "../shared/control-plane/source-boundary.mjs";
import {
  enforceActiveAppLimit,
} from "../shared/control-plane/workspace-resource-policy.mjs";
import { enforceRateLimit } from "../shared/control-plane/rate-limit.mjs";
import { safeCustomerDeployment } from "./customer-deployments.mjs";
import { getAuthorizedWorkspace } from "./customer-workspaces.mjs";
import { createInstallationOctokit } from "./github-app.mjs";

const ROOT_DIRECTORY = ".";

function splitRepository(fullName) {
  const [owner, repo] = String(fullName || "").split("/");
  if (!owner || !repo) {
    throw Object.assign(new Error("GitHub repository identity is invalid."), {
      status: 400,
      code: "INVALID_REPOSITORY_IDENTITY",
    });
  }
  return { owner, repo };
}

function slugFromRepository(fullName) {
  const name = String(fullName || "").split("/").at(-1) || "application";
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "application";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function detectPackageManager(rootFiles) {
  if (rootFiles.includes("pnpm-lock.yaml")) return { packageManager: "pnpm", lockfile: "pnpm-lock.yaml", installCommand: "pnpm install --frozen-lockfile" };
  if (rootFiles.includes("yarn.lock")) return { packageManager: "yarn", lockfile: "yarn.lock", installCommand: "yarn install --frozen-lockfile" };
  if (rootFiles.includes("package-lock.json")) return { packageManager: "npm", lockfile: "package-lock.json", installCommand: "npm ci" };
  return { packageManager: "npm", lockfile: null, installCommand: "npm install" };
}

function buildManifest({ repository, commitSha, gitTreeSha, rootDirectory, detection, commands, packageJson }) {
  const buildCommand = packageJson?.scripts?.build ? `${commands.packageManager} run build` : null;
  const startCommand = packageJson?.scripts?.start ? `${commands.packageManager} run start` : null;
  return {
    manifest: {
      version: 1,
      repository,
      commitSha,
      gitTreeSha,
      rootDirectory,
      framework: detection.framework,
      runtime: detection.runtime,
      packageManager: commands.packageManager,
      lockfile: commands.lockfile,
      installCommand: commands.installCommand,
      buildCommand,
      startCommand,
      packageName: packageJson?.name ?? null,
      packageVersion: packageJson?.version ?? null,
    },
    buildCommand,
    startCommand,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeErrorCode(error) {
  return typeof error?.code === "string" ? error.code : "REPOSITORY_ANALYSIS_FAILED";
}

function safeAnalysis(row) {
  const envKeys = Array.isArray(row.env_keys)
    ? row.env_keys.filter(Boolean).map(String).sort()
    : [];
  const supported = row.error_code
    ? false
    : Boolean(row.framework && row.runtime && row.build_command);
  const currentDeployment = row.deployment_id
    ? safeCustomerDeployment({
      id: row.deployment_id,
      parent_deployment_id: row.parent_deployment_id ?? null,
      app_id: row.app_id,
      status: row.status,
      error_code: row.error_code ?? null,
      source_commit_sha: row.source_commit_sha ?? null,
      source_branch: row.source_branch ?? null,
      orchestrator_run_id: row.orchestrator_run_id ?? null,
      live_url: row.live_url ?? null,
    })
    : null;
  return {
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    branch: row.source_branch ?? row.default_branch ?? "main",
    commitSha: row.source_commit_sha ?? null,
    shortCommitSha: row.source_commit_sha ? String(row.source_commit_sha).slice(0, 7) : null,
    appId: row.app_id ?? null,
    deploymentId: row.deployment_id ?? null,
    status: row.status ?? null,
    supported,
    errorCode: row.error_code ?? null,
    framework: row.framework ?? null,
    runtime: row.runtime ?? null,
    packageManager: row.package_manager ?? null,
    installCommand: row.install_command ?? null,
    buildCommand: row.build_command ?? null,
    startCommand: row.start_command ?? null,
    databaseRequired: Boolean(row.database_required),
    databaseMode: row.database_mode ?? null,
    envRequirementNames: envKeys,
    currentDeployment,
    valuesPrinted: false,
  };
}

export async function listWorkspaceRepositoryAnalyses(db, { customerId, workspaceId }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const result = await db.query(
    `
      SELECT
        r.id AS repository_id,
        r.full_name AS repository_full_name,
        r.default_branch,
        a.id AS app_id,
        a.database_required,
        a.database_mode,
        d.id AS deployment_id,
        d.parent_deployment_id,
        d.source_commit_sha,
        d.source_branch,
        d.status,
        d.error_code,
        d.orchestrator_run_id,
        d.live_url,
        bi.package_manager,
        bi.install_command,
        bi.build_command,
        bi.start_command,
        bi.manifest->>'framework' AS framework,
        bi.manifest->>'runtime' AS runtime,
        COALESCE(
          json_agg(det.env_key ORDER BY det.env_key)
            FILTER (WHERE det.env_key IS NOT NULL),
          '[]'::json
        ) AS env_keys
      FROM github_repositories r
      LEFT JOIN LATERAL (
        SELECT id, database_required, database_mode
        FROM apps
        WHERE workspace_id = r.workspace_id
          AND repository_id = r.id
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      ) a ON true
      LEFT JOIN LATERAL (
        SELECT id,
               parent_deployment_id,
               source_commit_sha,
               source_branch,
               status,
               error_code,
               orchestrator_run_id,
               live_url,
               created_at
        FROM deployments
        WHERE app_id = a.id
        ORDER BY created_at DESC
        LIMIT 1
      ) d ON true
      LEFT JOIN deployment_build_inputs bi ON bi.deployment_id = d.id
      LEFT JOIN deployment_env_requirement_detections det ON det.deployment_id = d.id
      WHERE r.workspace_id = $1
      GROUP BY
        r.id,
        r.full_name,
        r.default_branch,
        a.id,
        a.database_required,
        a.database_mode,
        d.id,
        d.parent_deployment_id,
        d.source_commit_sha,
        d.source_branch,
        d.status,
        d.error_code,
        d.orchestrator_run_id,
        d.live_url,
        bi.package_manager,
        bi.install_command,
        bi.build_command,
        bi.start_command,
        bi.manifest
      ORDER BY r.full_name ASC
    `,
    [workspaceId],
  );
  return result.rows.filter((row) => row.deployment_id).map(safeAnalysis);
}

export async function analyzeSelectedRepository(
  db,
  {
    customerId,
    workspaceId,
    repositoryId,
    createInstallationClient = createInstallationOctokit,
    deploymentKeyFactory = () => `dep_${crypto.randomUUID().replaceAll("-", "")}`,
  },
) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  // Repository analysis makes real GitHub API calls (getTree + one getBlob
  // per detectable file) against the platform's own shared GitHub App
  // credentials, not a per-customer token. Unthrottled, one workspace
  // repeatedly re-analyzing a large repo can exhaust that shared rate
  // budget and degrade analysis for every other tenant — a cross-tenant
  // consequence, not just a per-workspace nuisance. 30/hour is deliberately
  // generous for normal onboarding retries while still bounding abuse; tune
  // once real usage data exists.
  await enforceRateLimit(db, {
    workspaceId,
    action: "repository_analysis",
    limit: 30,
    windowSeconds: 3600,
  });
  const repository = await loadSelectedRepository(db, { workspaceId, repositoryId });
  const source = await inspectRepositorySource({
    repository,
    createInstallationClient,
  });

  return persistRepositoryAnalysis(db, {
    workspaceId,
    repository,
    source,
    deploymentKeyFactory,
  });
}

async function loadSelectedRepository(db, { workspaceId, repositoryId, forUpdate = false }) {
  const result = await db.query(
    `
      SELECT
        r.id,
        r.workspace_id,
        r.github_installation_id,
        r.github_repository_id,
        r.full_name,
        r.default_branch,
        r.private,
        gi.github_installation_id AS provider_installation_id
      FROM github_repositories r
      JOIN workspace_github_installations wgi
        ON wgi.workspace_id = r.workspace_id
       AND wgi.github_installation_id = r.github_installation_id
      JOIN github_installations gi ON gi.id = r.github_installation_id
      WHERE r.workspace_id = $1
        AND r.id = $2
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF r" : ""}
    `,
    [workspaceId, repositoryId],
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Selected repository is not available in this workspace."), {
      status: 404,
      code: "REPOSITORY_NOT_SELECTED",
    });
  }
  return result.rows[0];
}

async function inspectRepositorySource({ repository, createInstallationClient }) {
  const { owner, repo } = splitRepository(repository.full_name);
  const branch = repository.default_branch || "main";
  const octokit = await createInstallationClient({
    installationId: Number(repository.provider_installation_id),
  });
  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const commitSha = ref.data.object.sha;
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw Object.assign(new Error("GitHub branch did not resolve to a commit SHA."), {
      status: 502,
      code: "GITHUB_BRANCH_HEAD_INVALID",
    });
  }

  const commit = await octokit.git.getCommit({ owner, repo, commit_sha: commitSha });
  const gitTreeSha = commit.data.tree.sha;
  const rootDirectory = normalizeRootDirectory(ROOT_DIRECTORY);
  const root = await octokit.repos.getContent({ owner, repo, path: "", ref: commitSha });
  if (!Array.isArray(root.data)) {
    throw Object.assign(new Error("Repository root is not a directory."), {
      status: 400,
      code: "REPOSITORY_ROOT_INVALID",
    });
  }

  const rootFiles = root.data.map((entry) => entry.name).sort();
  const packageEntry = root.data.find((entry) => entry.type === "file" && entry.name === "package.json");
  let packageJson = null;
  if (packageEntry) {
    const packageResponse = await octokit.repos.getContent({ owner, repo, path: "package.json", ref: commitSha });
    if (!Array.isArray(packageResponse.data) && packageResponse.data.type === "file" && packageResponse.data.content) {
      packageJson = JSON.parse(Buffer.from(packageResponse.data.content, "base64").toString("utf8"));
    }
  }

  const detection = detectProject({ packageJson, rootFiles });
  const commands = detectPackageManager(rootFiles);
  const { manifest, buildCommand, startCommand } = buildManifest({
    repository: repository.full_name,
    commitSha,
    gitTreeSha,
    rootDirectory,
    detection,
    commands,
    packageJson,
  });
  const manifestSha256 = sha256(stableJson(manifest));
  const envAnalysis = detection.supported
    ? await detectEnvironmentReferences({ octokit, owner, repo, gitTreeSha, rootDirectory })
    : { detections: [], scannedFileCount: 0, skippedFileCount: 0, skippedFiles: [] };

  return {
    branch,
    commitSha,
    gitTreeSha,
    rootDirectory,
    rootFiles,
    packageJson,
    detection,
    commands,
    buildCommand,
    startCommand,
    manifest,
    manifestSha256,
    envAnalysis,
  };
}

async function detectEnvironmentReferences({ octokit, owner, repo, gitTreeSha, rootDirectory }) {
  const tree = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: gitTreeSha,
    recursive: "true",
  });
  if (tree.data.truncated) {
    throw Object.assign(new Error("GitHub returned a truncated source tree."), {
      status: 400,
      code: "SOURCE_TREE_TRUNCATED",
    });
  }
  const entries = tree.data.tree.filter((entry) => entry.path);
  const normalizedPaths = assertUniqueRepositoryPaths(entries.map((entry) => entry.path));
  const normalizedByOriginalPath = new Map();
  entries.forEach((entry, index) => normalizedByOriginalPath.set(entry.path, normalizedPaths[index]));
  const sourceFiles = tree.data.tree
    .filter((entry) => entry.type === "blob" && entry.path && entry.sha)
    .map((entry) => ({
      path: normalizedByOriginalPath.get(entry.path),
      sha: entry.sha,
      rootRelativePath: relativePathUnderRoot(entry.path, rootDirectory),
    }))
    .filter((entry) => entry.rootRelativePath !== null && isDetectableSourcePath(entry.rootRelativePath));
  assertDetectableSourceFileCount(sourceFiles.length);

  const fileDetections = [];
  const skippedFiles = [];
  let scannedFileCount = 0;
  let skippedFileCount = 0;
  let totalSourceBytes = 0;

  for (const file of sourceFiles) {
    const blob = await octokit.git.getBlob({ owner, repo, file_sha: file.sha });
    if (blob.data.encoding !== "base64") {
      skippedFileCount += 1;
      skippedFiles.push({ path: file.rootRelativePath, reason: "UNSUPPORTED_BLOB_ENCODING" });
      continue;
    }
    const raw = Buffer.from(blob.data.content, "base64");
    totalSourceBytes += raw.byteLength;
    assertTotalSourceBytes(totalSourceBytes);
    const detection = detectEnvReferencesInSource({
      path: file.rootRelativePath,
      content: raw.toString("utf8"),
    });
    if (detection.skipped) {
      skippedFileCount += 1;
      skippedFiles.push({ path: file.rootRelativePath, reason: detection.reason ?? "SOURCE_FILE_SKIPPED" });
      continue;
    }
    scannedFileCount += 1;
    fileDetections.push(detection.detections);
  }

  return {
    detections: mergeEnvDetections(fileDetections),
    scannedFileCount,
    skippedFileCount,
    skippedFiles: skippedFiles.slice(0, 100),
  };
}

async function persistRepositoryAnalysis(db, { workspaceId, repository, source, deploymentKeyFactory }) {
  await db.query("BEGIN");
  try {
    await loadSelectedRepository(db, { workspaceId, repositoryId: repository.id, forUpdate: true });
    const app = await createOrReuseApp(db, { workspaceId, repository, source });
    const deployment = await createOrReuseDeployment(db, {
      workspaceId,
      app,
      repository,
      source,
      deploymentKeyFactory,
    });

    if (source.detection.supported && source.buildCommand) {
      await persistBuildInput(db, { deployment, repository, source });
      await persistEnvironmentDetection(db, { workspaceId, app, deployment, repository, source });
      await recordAnalysisCompleted(db, { deployment, source });
    } else {
      await markUnsupported(db, { deployment, source });
    }

    await db.query("COMMIT");
    return analysisResultFromSource({ repository, app, deployment, source });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function createOrReuseApp(db, { workspaceId, repository, source }) {
  const appName = repository.full_name.split("/").at(-1);
  const slug = slugFromRepository(repository.full_name);
  const databaseRequired = Boolean(source.detection.databaseRequired);
  const databaseMode = databaseRequired ? "SSC_MANAGED" : "NONE";
  const existingForRepository = await db.query(
    `SELECT id, workspace_id, repository_id, name, slug, framework, runtime, database_required, database_mode, deleted_at
       FROM apps
      WHERE workspace_id = $1
        AND repository_id = $2
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE`,
    [workspaceId, repository.id],
  );
  if (existingForRepository.rows[0]) {
    const updated = await db.query(
      `UPDATE apps
          SET name = $1,
              framework = $2,
              runtime = $3,
              database_required = $4,
              database_mode = $5,
              updated_at = now()
        WHERE id = $6
        RETURNING id, workspace_id, repository_id, name, slug, framework, runtime, database_required, database_mode`,
      [appName, source.detection.framework, source.detection.runtime, databaseRequired, databaseMode, existingForRepository.rows[0].id],
    );
    return updated.rows[0];
  }

  const existingSlug = await db.query(
    `SELECT id, repository_id, deleted_at
       FROM apps
      WHERE workspace_id = $1
        AND slug = $2
      LIMIT 1
      FOR UPDATE`,
    [workspaceId, slug],
  );
  if (existingSlug.rows[0]) {
    throw Object.assign(new Error("Application slug already belongs to another repository."), {
      status: 409,
      code: existingSlug.rows[0].deleted_at ? "APP_SLUG_DELETED_REQUIRES_RECOVERY" : "APP_SLUG_CONFLICT",
    });
  }

  await enforceActiveAppLimit(db, { workspaceId });
  const created = await db.query(
    `INSERT INTO apps
       (workspace_id, repository_id, name, slug, framework, runtime, database_required, database_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, workspace_id, repository_id, name, slug, framework, runtime, database_required, database_mode`,
    [workspaceId, repository.id, appName, slug, source.detection.framework, source.detection.runtime, databaseRequired, databaseMode],
  );
  return created.rows[0];
}

async function createOrReuseDeployment(db, { workspaceId, app, repository, source, deploymentKeyFactory }) {
  const existing = await db.query(
    `SELECT id, deployment_key, source_commit_sha, source_branch, status, error_code, created_at
       FROM deployments
      WHERE app_id = $1
        AND source_commit_sha = $2
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE`,
    [app.id, source.commitSha],
  );
  if (existing.rows[0]) return { ...existing.rows[0], reused: true };

  const created = await db.query(
    `INSERT INTO deployments
       (deployment_key, workspace_id, app_id, source_commit_sha, source_branch, status)
     VALUES ($1,$2,$3,$4,$5,'ANALYZING')
     RETURNING id, deployment_key, source_commit_sha, source_branch, status, error_code, created_at`,
    [deploymentKeyFactory(), workspaceId, app.id, source.commitSha, source.branch],
  );
  const deployment = created.rows[0];
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,'DRAFT','ANALYZING','STATUS_CHANGED',$2,$3::jsonb)`,
    [
      deployment.id,
      "Repository analysis started from selected source",
      JSON.stringify({ repository: repository.full_name, commitSha: source.commitSha, branch: source.branch }),
    ],
  );
  return deployment;
}

async function persistBuildInput(db, { deployment, repository, source }) {
  const existing = await db.query(
    `SELECT id FROM deployment_build_inputs WHERE deployment_id = $1`,
    [deployment.id],
  );
  if (existing.rowCount === 1) return;
  await db.query(
    `INSERT INTO deployment_build_inputs
       (deployment_id, repository_full_name, commit_sha, git_tree_sha, root_directory,
        package_manager, lockfile, install_command, build_command, start_command,
        manifest_sha256, manifest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      deployment.id,
      repository.full_name,
      source.commitSha,
      source.gitTreeSha,
      source.rootDirectory,
      source.commands.packageManager,
      source.commands.lockfile,
      source.commands.installCommand,
      source.buildCommand,
      source.startCommand,
      source.manifestSha256,
      JSON.stringify(source.manifest),
    ],
  );
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,'ANALYZING','ANALYZING','BUILD_INPUT_PREPARED',
             'Immutable source and build input prepared', $2::jsonb)`,
    [deployment.id, JSON.stringify({ commitSha: source.commitSha, gitTreeSha: source.gitTreeSha, manifestSha256: source.manifestSha256 })],
  );
}

async function persistEnvironmentDetection(db, { workspaceId, app, deployment, repository, source }) {
  const existing = await db.query(
    `SELECT id FROM deployment_env_detection_snapshots WHERE deployment_id = $1`,
    [deployment.id],
  );
  if (existing.rowCount === 1) return;

  const detections = source.envAnalysis.detections;
  const snapshotPayload = {
    detectorVersion: ENV_DETECTOR_VERSION,
    repository: repository.full_name,
    commitSha: source.commitSha,
    gitTreeSha: source.gitTreeSha,
    rootDirectory: source.rootDirectory,
    sourceLimits: {
      maxDetectableSourceFiles: SOURCE_LIMITS.maxDetectableSourceFiles,
      maxTotalSourceBytes: SOURCE_LIMITS.maxTotalSourceBytes,
      maxSingleSourceFileBytes: SOURCE_LIMITS.maxSingleSourceFileBytes,
      maxRepositoryPathLength: SOURCE_LIMITS.maxRepositoryPathLength,
    },
    detectedKeys: detections.map((item) => item.envKey),
    scannedFileCount: source.envAnalysis.scannedFileCount,
    skippedFileCount: source.envAnalysis.skippedFileCount,
    skippedFiles: source.envAnalysis.skippedFiles,
  };
  const snapshot = await db.query(
    `INSERT INTO deployment_env_detection_snapshots
       (deployment_id, workspace_id, app_id, repository_full_name, commit_sha, git_tree_sha,
        root_directory, detector_version, detected_count, scanned_file_count, skipped_file_count, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     RETURNING id`,
    [
      deployment.id,
      workspaceId,
      app.id,
      repository.full_name,
      source.commitSha,
      source.gitTreeSha,
      source.rootDirectory,
      ENV_DETECTOR_VERSION,
      detections.length,
      source.envAnalysis.scannedFileCount,
      source.envAnalysis.skippedFileCount,
      JSON.stringify(snapshotPayload),
    ],
  );
  const snapshotId = snapshot.rows[0].id;

  for (const detection of detections) {
    const requirement = sourceDetectedRequirement(detection);
    await db.query(
      `INSERT INTO deployment_env_requirement_detections
         (snapshot_id, deployment_id, workspace_id, app_id, env_key, reference_kind,
          required_inference, public, sources)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        snapshotId,
        deployment.id,
        workspaceId,
        app.id,
        detection.envKey,
        detection.referenceKind,
        detection.requiredInference,
        detection.public,
        JSON.stringify(detection.sources),
      ],
    );
    await db.query(
      `INSERT INTO app_env_requirements
         (workspace_id, app_id, env_key, source, required, public)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (app_id, env_key) DO UPDATE SET
         public = app_env_requirements.public OR EXCLUDED.public,
         updated_at = CASE
           WHEN app_env_requirements.public IS DISTINCT FROM (app_env_requirements.public OR EXCLUDED.public)
           THEN now()
           ELSE app_env_requirements.updated_at
         END`,
      [workspaceId, app.id, requirement.envKey, requirement.source, requirement.required, requirement.public],
    );
  }

  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,'ANALYZING','ANALYZING','ENV_REQUIREMENTS_DETECTED',
             'Source-scoped environment references detected', $2::jsonb)`,
    [deployment.id, JSON.stringify({
      detectorVersion: ENV_DETECTOR_VERSION,
      commitSha: source.commitSha,
      gitTreeSha: source.gitTreeSha,
      detectedCount: detections.length,
      scannedFileCount: source.envAnalysis.scannedFileCount,
      skippedFileCount: source.envAnalysis.skippedFileCount,
      detectedKeys: detections.map((item) => item.envKey),
      valuesPrinted: false,
    })],
  );
}

async function markUnsupported(db, { deployment, source }) {
  if (await hasDeploymentEvent(db, { deploymentId: deployment.id, eventType: "PROJECT_ANALYSIS_UNSUPPORTED" })) {
    return;
  }
  const code = source.detection.reason || "UNSUPPORTED_PROJECT";
  await db.query(
    `UPDATE deployments
        SET error_code = $1,
            error_message = $2,
            updated_at = now()
      WHERE id = $3
        AND status = 'ANALYZING'`,
    [code, "Repository does not match the supported V1 application contract.", deployment.id],
  );
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,'ANALYZING','ANALYZING','PROJECT_ANALYSIS_UNSUPPORTED',$2,$3::jsonb)`,
    [
      deployment.id,
      "Repository analysis found an unsupported project",
      JSON.stringify({ reason: code, valuesPrinted: false }),
    ],
  );
  deployment.error_code = code;
}

async function recordAnalysisCompleted(db, { deployment, source }) {
  if (await hasDeploymentEvent(db, { deploymentId: deployment.id, eventType: "PROJECT_ANALYSIS_COMPLETED" })) {
    return;
  }
  await db.query(
    `UPDATE deployments
        SET error_code = NULL,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1
        AND status = 'ANALYZING'`,
    [deployment.id],
  );
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,'ANALYZING','ANALYZING','PROJECT_ANALYSIS_COMPLETED',$2,$3::jsonb)`,
    [
      deployment.id,
      "Repository analysis completed without provider side effects",
      JSON.stringify({
        commitSha: source.commitSha,
        framework: source.detection.framework,
        runtime: source.detection.runtime,
        databaseRequired: Boolean(source.detection.databaseRequired),
        detectedEnvCount: source.envAnalysis.detections.length,
        providerCallsExecuted: false,
        triggerCallsExecuted: false,
      }),
    ],
  );
}

async function hasDeploymentEvent(db, { deploymentId, eventType }) {
  const result = await db.query(
    `SELECT id FROM deployment_events WHERE deployment_id = $1 AND event_type = $2 LIMIT 1`,
    [deploymentId, eventType],
  );
  return result.rowCount === 1;
}

function analysisResultFromSource({ repository, app, deployment, source }) {
  const supported = Boolean(source.detection.supported && source.buildCommand);
  const code = supported ? null : source.detection.reason || "UNSUPPORTED_PROJECT";
  return {
    result: supported ? "REPOSITORY_ANALYSIS_READY" : "REPOSITORY_ANALYSIS_UNSUPPORTED",
    repositoryId: repository.id,
    repositoryFullName: repository.full_name,
    branch: source.branch,
    commitSha: source.commitSha,
    shortCommitSha: source.commitSha.slice(0, 7),
    appId: app.id,
    deploymentId: deployment.id,
    status: deployment.status,
    supported,
    errorCode: code,
    framework: source.detection.framework,
    runtime: source.detection.runtime,
    packageManager: source.commands.packageManager,
    installCommand: source.commands.installCommand,
    buildCommand: source.buildCommand,
    startCommand: source.startCommand,
    databaseRequired: Boolean(source.detection.databaseRequired),
    databaseMode: Boolean(source.detection.databaseRequired) ? "SSC_MANAGED" : "NONE",
    envRequirementNames: source.envAnalysis.detections.map((item) => item.envKey).sort(),
    providerCallsExecuted: false,
    triggerCallsExecuted: false,
    valuesPrinted: false,
  };
}

export function safeRepositoryAnalysisError(error) {
  return {
    error: safeErrorCode(error),
    message: customerMessageForCode(safeErrorCode(error)),
  };
}

function customerMessageForCode(code) {
  const messages = {
    REPOSITORY_NOT_SELECTED: "Select a repository before analysing it.",
    GITHUB_BRANCH_HEAD_INVALID: "Utplava could not resolve the repository branch to a commit.",
    SOURCE_TREE_TRUNCATED: "The repository is too large for V1 source analysis.",
    PACKAGE_JSON_NOT_FOUND: "The repository does not contain a package.json at the root.",
    UNSUPPORTED_PROJECT: "This repository is not a supported V1 Next.js or Node.js project.",
    APP_SLUG_CONFLICT: "This application name is already used by another repository in the workspace.",
    WORKSPACE_RATE_LIMIT_REACHED: "You've hit the limit for this action right now — please wait a bit and try again.",
  };
  return messages[code] || "Repository analysis could not be completed safely.";
}
