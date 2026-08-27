import { createHash } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { task } from "@trigger.dev/sdk";
import pg from "pg";

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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function detectPackageManager(rootFiles: string[]) {
  if (rootFiles.includes("pnpm-lock.yaml")) return { packageManager: "pnpm", lockfile: "pnpm-lock.yaml", installCommand: "pnpm install --frozen-lockfile" };
  if (rootFiles.includes("yarn.lock")) return { packageManager: "yarn", lockfile: "yarn.lock", installCommand: "yarn install --frozen-lockfile" };
  if (rootFiles.includes("package-lock.json")) return { packageManager: "npm", lockfile: "package-lock.json", installCommand: "npm ci" };
  return { packageManager: "npm", lockfile: null, installCommand: "npm install" };
}

export const prepareBuildInput = task({
  id: "ssc-control-plane-prepare-build-input",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
      if (!process.env[name]) throw new Error(`Missing ${name}`);
    }

    return await withDb(async (db) => {
      const deploymentResult = await db.query(
        `SELECT d.id, d.workspace_id, d.app_id, d.source_commit_sha, d.status,
                a.root_directory, a.framework, a.runtime,
                r.full_name AS repository_full_name,
                i.github_installation_id
           FROM deployments d
           JOIN apps a ON a.id = d.app_id
           JOIN github_repositories r ON r.id = a.repository_id
           JOIN github_installations i ON i.id = r.github_installation_id
          WHERE d.id = $1`,
        [payload.deploymentId],
      );
      if (deploymentResult.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
      const deployment = deploymentResult.rows[0];
      if (deployment.status !== "ANALYZING" && deployment.status !== "PROVISIONING") {
        throw new Error(`Build input cannot be prepared from status ${deployment.status}`);
      }

      const existing = await db.query(
        `SELECT repository_full_name, commit_sha, git_tree_sha, root_directory,
                package_manager, lockfile, install_command, build_command,
                start_command, manifest_sha256
           FROM deployment_build_inputs WHERE deployment_id = $1`,
        [payload.deploymentId],
      );
      if (existing.rowCount === 1) {
        const input = existing.rows[0];
        if (input.commit_sha !== deployment.source_commit_sha || input.repository_full_name !== deployment.repository_full_name) {
          throw new Error("Immutable build input does not match deployment source identity");
        }
        return { result: "NODE_04_7_REPLAY_NOOP", deploymentId: payload.deploymentId, status: deployment.status, ...input };
      }

      const [owner, repo] = deployment.repository_full_name.split("/");
      const auth = createAppAuth({ appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n") });
      const installationAuth = await auth({ type: "installation", installationId: Number(deployment.github_installation_id) });
      const octokit = new Octokit({ auth: installationAuth.token });

      const commit = await octokit.git.getCommit({ owner, repo, commit_sha: deployment.source_commit_sha });
      const gitTreeSha = commit.data.tree.sha;
      const rootPath = deployment.root_directory === "." ? "" : deployment.root_directory;
      const root = await octokit.repos.getContent({ owner, repo, path: rootPath, ref: deployment.source_commit_sha });
      if (!Array.isArray(root.data)) throw new Error("Configured root directory is not a directory");
      const rootFiles = root.data.map((entry) => entry.name).sort();
      if (!rootFiles.includes("package.json")) throw new Error("Supported Node.js workload requires package.json in root directory");

      const packagePath = rootPath ? `${rootPath}/package.json` : "package.json";
      const packageResponse = await octokit.repos.getContent({ owner, repo, path: packagePath, ref: deployment.source_commit_sha });
      if (Array.isArray(packageResponse.data) || packageResponse.data.type !== "file" || !packageResponse.data.content) throw new Error("Unable to read package.json");
      const packageJson = JSON.parse(Buffer.from(packageResponse.data.content, "base64").toString("utf8"));
      const commands = detectPackageManager(rootFiles);
      const buildCommand = packageJson.scripts?.build ? `${commands.packageManager} run build` : null;
      if (!buildCommand) throw new Error("Supported workload requires a package.json build script");
      const startCommand = packageJson.scripts?.start ? `${commands.packageManager} run start` : null;

      const manifest = {
        version: 1,
        repository: deployment.repository_full_name,
        commitSha: deployment.source_commit_sha,
        gitTreeSha,
        rootDirectory: deployment.root_directory,
        framework: deployment.framework,
        runtime: deployment.runtime,
        packageManager: commands.packageManager,
        lockfile: commands.lockfile,
        installCommand: commands.installCommand,
        buildCommand,
        startCommand,
        packageName: packageJson.name ?? null,
        packageVersion: packageJson.version ?? null,
      };
      const manifestSha256 = createHash("sha256").update(stableJson(manifest)).digest("hex");

      await db.query("BEGIN");
      try {
        await db.query(
          `INSERT INTO deployment_build_inputs
             (deployment_id, repository_full_name, commit_sha, git_tree_sha, root_directory,
              package_manager, lockfile, install_command, build_command, start_command,
              manifest_sha256, manifest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [payload.deploymentId, deployment.repository_full_name, deployment.source_commit_sha, gitTreeSha,
           deployment.root_directory, commands.packageManager, commands.lockfile, commands.installCommand,
           buildCommand, startCommand, manifestSha256, JSON.stringify(manifest)],
        );
        const advanced = await db.query(
          `UPDATE deployments SET status = 'PROVISIONING', updated_at = now()
            WHERE id = $1 AND status = 'ANALYZING' RETURNING id`,
          [payload.deploymentId],
        );
        if (advanced.rowCount === 1) {
          await db.query(
            `INSERT INTO deployment_events
               (deployment_id, from_status, to_status, event_type, message, metadata)
             VALUES ($1, 'ANALYZING', 'PROVISIONING', 'BUILD_INPUT_PREPARED',
                     'Immutable source and build input prepared', $2::jsonb)`,
            [payload.deploymentId, JSON.stringify({ commitSha: deployment.source_commit_sha, gitTreeSha, manifestSha256 })],
          );
        }
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      return {
        result: "NODE_04_7_BUILD_INPUT_PREPARED",
        deploymentId: payload.deploymentId,
        status: "PROVISIONING",
        repository: deployment.repository_full_name,
        commitSha: deployment.source_commit_sha,
        gitTreeSha,
        rootDirectory: deployment.root_directory,
        packageManager: commands.packageManager,
        lockfile: commands.lockfile,
        installCommand: commands.installCommand,
        buildCommand,
        startCommand,
        manifestSha256,
        installationTokenPrinted: false,
        privateKeyPrinted: false,
      };
    });
  },
});
