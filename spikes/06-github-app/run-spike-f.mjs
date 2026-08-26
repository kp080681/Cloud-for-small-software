import "dotenv/config";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_INSTALLATION_ID"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const appId = process.env.GITHUB_APP_ID;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
const installationId = Number(process.env.GITHUB_INSTALLATION_ID);
if (!Number.isInteger(installationId) || installationId <= 0) throw new Error("GITHUB_INSTALLATION_ID must be a positive integer");

// Allow for local clock skew when GitHub validates the short-lived App JWT.
const auth = createAppAuth({ appId, privateKey, timeDifference: 60 });
const installationAuth = await auth({ type: "installation", installationId });
const octokit = new Octokit({ auth: installationAuth.token });

const installation = await octokit.apps.getInstallation({ installation_id: installationId });
const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, { per_page: 100 });

if (repos.length === 0) throw new Error("GitHub App installation has no accessible repositories");

const targetFullName = process.env.SPIKE_GITHUB_REPOSITORY || repos[0].full_name;
const target = repos.find((repo) => repo.full_name.toLowerCase() === targetFullName.toLowerCase());
if (!target) throw new Error(`Target repository is not accessible to this installation: ${targetFullName}`);

const [owner, repo] = target.full_name.split("/");
const repoInfo = await octokit.repos.get({ owner, repo });
const branch = repoInfo.data.default_branch;
const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
const root = await octokit.repos.getContent({ owner, repo, path: "", ref: branch });
if (!Array.isArray(root.data)) throw new Error("Expected repository root to be a directory listing");

const packageJson = root.data.find((entry) => entry.type === "file" && entry.name === "package.json");
let packageJsonReadable = false;
if (packageJson) {
  const pkg = await octokit.repos.getContent({ owner, repo, path: "package.json", ref: branch });
  packageJsonReadable = !Array.isArray(pkg.data) && pkg.data.type === "file" && Boolean(pkg.data.content);
}

console.log(JSON.stringify({
  result: "SPIKE_F_PASS",
  appAuthentication: true,
  installationAuthentication: true,
  installationId,
  installationAccount: installation.data.account?.login ?? null,
  repositoryCount: repos.length,
  repository: target.full_name,
  privateRepository: target.private,
  defaultBranch: branch,
  sha: ref.data.object.sha,
  rootReadable: true,
  packageJsonPresent: Boolean(packageJson),
  packageJsonReadable,
  installationTokenPrinted: false,
  privateKeyPrinted: false
}, null, 2));
