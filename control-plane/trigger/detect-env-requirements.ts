import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  ENV_DETECTOR_VERSION,
  detectEnvReferencesInSource,
  isDetectableSourcePath,
  mergeEnvDetections,
} from "../src/env-requirement-detection.mjs";
import { sourceDetectedRequirement } from "../src/env-requirement-reconciliation.mjs";
import {
  SOURCE_LIMITS,
  assertDetectableSourceFileCount,
  assertTotalSourceBytes,
  assertUniqueRepositoryPaths,
  normalizeRootDirectory,
  relativePathUnderRoot,
} from "../src/source-boundary.mjs";
import { assertRepositoryInWorkspace } from "../src/tenant-boundary.mjs";

const { Client } = pg;

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export const detectEnvRequirements = task({
  id: "ssc-control-plane-detect-env-requirements",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
      if (!process.env[name]) throw new Error(`Missing ${name}`);
    }

    return await withDb(async (db) => {
      const deploymentResult = await db.query(
        `SELECT d.id, d.workspace_id, d.app_id, d.source_commit_sha, d.status,
                bi.repository_full_name, bi.commit_sha, bi.git_tree_sha, bi.root_directory,
                r.workspace_id AS repository_workspace_id,
                r.full_name AS app_repository_full_name,
                i.github_installation_id
           FROM deployments d
           JOIN deployment_build_inputs bi ON bi.deployment_id = d.id
           JOIN apps a ON a.id = d.app_id
           JOIN github_repositories r ON r.id = a.repository_id
           JOIN github_installations i ON i.id = r.github_installation_id
          WHERE d.id = $1`,
        [payload.deploymentId],
      );
      if (deploymentResult.rowCount === 0) throw new Error(`Deployment build input not found: ${payload.deploymentId}`);
      const deployment = deploymentResult.rows[0];
      if (deployment.status !== "ANALYZING") throw new Error(`Environment detection can only run from ANALYZING; current status is ${deployment.status}`);
      if (deployment.commit_sha !== deployment.source_commit_sha) throw new Error("Build input source identity does not match deployment");
      assertRepositoryInWorkspace({
        workspace_id: deployment.repository_workspace_id,
        full_name: deployment.app_repository_full_name,
      }, deployment.workspace_id);
      if (deployment.repository_full_name !== deployment.app_repository_full_name) {
        throw new Error("Build input repository does not match app repository");
      }

      const existingSnapshot = await db.query(
        `SELECT id, repository_full_name, commit_sha, git_tree_sha, root_directory,
                detector_version, detected_count, scanned_file_count, skipped_file_count
           FROM deployment_env_detection_snapshots
          WHERE deployment_id = $1`,
        [payload.deploymentId],
      );
      if (existingSnapshot.rowCount === 1) {
        const snapshot = existingSnapshot.rows[0];
        if (
          snapshot.repository_full_name !== deployment.repository_full_name ||
          snapshot.commit_sha !== deployment.commit_sha ||
          snapshot.git_tree_sha !== deployment.git_tree_sha ||
          snapshot.root_directory !== deployment.root_directory
        ) {
          throw new Error("Immutable environment detection snapshot does not match build input");
        }
        return {
          result: "NODE_04_17_ENV_DETECTION_REPLAY_NOOP",
          deploymentId: payload.deploymentId,
          snapshotId: snapshot.id,
          detectorVersion: snapshot.detector_version,
          detectedCount: Number(snapshot.detected_count),
          scannedFileCount: Number(snapshot.scanned_file_count),
          skippedFileCount: Number(snapshot.skipped_file_count),
        };
      }

      const [owner, repo] = String(deployment.repository_full_name).split("/");
      if (!owner || !repo) throw new Error(`Invalid GitHub repository identity: ${deployment.repository_full_name}`);

      const auth = createAppAuth({ appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n") });
      const installationAuth = await auth({ type: "installation", installationId: Number(deployment.github_installation_id) });
      const octokit = new Octokit({ auth: installationAuth.token });

      const tree = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: deployment.git_tree_sha,
        recursive: "true",
      });
      if (tree.data.truncated) throw new Error("GitHub returned a truncated source tree; environment detection would be incomplete");
      const normalizedPaths = assertUniqueRepositoryPaths(tree.data.tree.filter((entry) => entry.path).map((entry) => entry.path!));
      const normalizedByOriginalPath = new Map<string, string>();
      tree.data.tree.filter((entry) => entry.path).forEach((entry, index) => normalizedByOriginalPath.set(entry.path!, normalizedPaths[index]));
      const rootDirectory = normalizeRootDirectory(deployment.root_directory);

      const sourceFiles = tree.data.tree
        .filter((entry) => entry.type === "blob" && entry.path && entry.sha)
        .map((entry) => ({ path: normalizedByOriginalPath.get(entry.path!)!, sha: entry.sha!, rootRelativePath: relativePathUnderRoot(entry.path!, rootDirectory) }))
        .filter((entry) => entry.rootRelativePath !== null && isDetectableSourcePath(entry.rootRelativePath));
      assertDetectableSourceFileCount(sourceFiles.length);

      const fileDetections = [];
      let scannedFileCount = 0;
      let skippedFileCount = 0;
      let totalSourceBytes = 0;
      const skippedFiles: Array<{ path: string; reason: string }> = [];

      for (const file of sourceFiles) {
        const blob = await octokit.git.getBlob({ owner, repo, file_sha: file.sha });
        if (blob.data.encoding !== "base64") {
          skippedFileCount += 1;
          skippedFiles.push({ path: file.rootRelativePath!, reason: "UNSUPPORTED_BLOB_ENCODING" });
          continue;
        }
        const raw = Buffer.from(blob.data.content, "base64");
        totalSourceBytes += raw.byteLength;
        assertTotalSourceBytes(totalSourceBytes);
        const content = raw.toString("utf8");
        const detection = detectEnvReferencesInSource({ path: file.rootRelativePath!, content });
        if (detection.skipped) {
          skippedFileCount += 1;
          skippedFiles.push({ path: file.rootRelativePath!, reason: detection.reason ?? "SOURCE_FILE_SKIPPED" });
          continue;
        }
        scannedFileCount += 1;
        fileDetections.push(detection.detections);
      }

      const detections = mergeEnvDetections(fileDetections);
      const snapshotPayload = {
        detectorVersion: ENV_DETECTOR_VERSION,
        repository: deployment.repository_full_name,
        commitSha: deployment.commit_sha,
        gitTreeSha: deployment.git_tree_sha,
        rootDirectory,
        sourceLimits: {
          maxDetectableSourceFiles: SOURCE_LIMITS.maxDetectableSourceFiles,
          maxTotalSourceBytes: SOURCE_LIMITS.maxTotalSourceBytes,
          maxSingleSourceFileBytes: SOURCE_LIMITS.maxSingleSourceFileBytes,
          maxRepositoryPathLength: SOURCE_LIMITS.maxRepositoryPathLength,
        },
        detectedKeys: detections.map((item) => item.envKey),
        scannedFileCount,
        skippedFileCount,
        skippedFiles: skippedFiles.slice(0, 100),
      };

      await db.query("BEGIN");
      try {
        const snapshot = await db.query(
          `INSERT INTO deployment_env_detection_snapshots
             (deployment_id, workspace_id, app_id, repository_full_name, commit_sha, git_tree_sha,
              root_directory, detector_version, detected_count, scanned_file_count, skipped_file_count, snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
           RETURNING id`,
          [
            payload.deploymentId,
            deployment.workspace_id,
            deployment.app_id,
            deployment.repository_full_name,
            deployment.commit_sha,
            deployment.git_tree_sha,
            rootDirectory,
            ENV_DETECTOR_VERSION,
            detections.length,
            scannedFileCount,
            skippedFileCount,
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
              payload.deploymentId,
              deployment.workspace_id,
              deployment.app_id,
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
            [
              deployment.workspace_id,
              deployment.app_id,
              requirement.envKey,
              requirement.source,
              requirement.required,
              requirement.public,
            ],
          );
        }

        await db.query(
          `INSERT INTO deployment_events
             (deployment_id, from_status, to_status, event_type, message, metadata)
           VALUES ($1,'ANALYZING','ANALYZING','ENV_REQUIREMENTS_DETECTED',
                   'Source-scoped environment references detected', $2::jsonb)`,
          [payload.deploymentId, JSON.stringify({
            detectorVersion: ENV_DETECTOR_VERSION,
            commitSha: deployment.commit_sha,
            gitTreeSha: deployment.git_tree_sha,
            detectedCount: detections.length,
            scannedFileCount,
            skippedFileCount,
            detectedKeys: detections.map((item) => item.envKey),
            valuesPrinted: false,
          })],
        );
        await db.query("COMMIT");
        return {
          result: "NODE_04_17_ENV_REQUIREMENTS_DETECTED",
          deploymentId: payload.deploymentId,
          snapshotId,
          detectorVersion: ENV_DETECTOR_VERSION,
          detectedCount: detections.length,
          detectedKeys: detections.map((item) => item.envKey),
          scannedFileCount,
          skippedFileCount,
          installationTokenPrinted: false,
          privateKeyPrinted: false,
          valuesPrinted: false,
        };
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    });
  },
});
