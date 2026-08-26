import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import pg from "pg";
import { detectProject } from "../src/project-detection.mjs";

for (const name of ["DATABASE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const repositoryResult = await db.query(
    `SELECT r.id, r.workspace_id, r.full_name, r.default_branch,
            i.github_installation_id
       FROM github_repositories r
       JOIN github_installations i ON i.id = r.github_installation_id
      ORDER BY r.updated_at DESC
      LIMIT 1`,
  );

  if (repositoryResult.rowCount === 0) throw new Error("No mapped GitHub repository found");
  const repository = repositoryResult.rows[0];
  const installationId = Number(repository.github_installation_id);
  const [owner, repo] = repository.full_name.split("/");

  const auth = createAppAuth({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
  const installationAuth = await auth({ type: "installation", installationId });
  const octokit = new Octokit({ auth: installationAuth.token });

  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${repository.default_branch}` });
  const commitSha = ref.data.object.sha;
  const root = await octokit.repos.getContent({ owner, repo, path: "", ref: commitSha });
  if (!Array.isArray(root.data)) throw new Error("Repository root is not a directory");

  const rootFiles = root.data.map((entry) => entry.name);
  const packageEntry = root.data.find((entry) => entry.type === "file" && entry.name === "package.json");
  let packageJson = null;

  if (packageEntry) {
    const packageResponse = await octokit.repos.getContent({ owner, repo, path: "package.json", ref: commitSha });
    if (!Array.isArray(packageResponse.data) && packageResponse.data.type === "file" && packageResponse.data.content) {
      packageJson = JSON.parse(Buffer.from(packageResponse.data.content, "base64").toString("utf8"));
    }
  }

  const detection = detectProject({ packageJson, rootFiles });

  console.log(JSON.stringify({
    result: "NODE_04_3_INSPECTED",
    repository: repository.full_name,
    branch: repository.default_branch,
    commitSha,
    rootDirectory: ".",
    rootEntryCount: rootFiles.length,
    packageJsonPresent: Boolean(packageJson),
    detection,
    installationTokenPrinted: false,
    privateKeyPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
