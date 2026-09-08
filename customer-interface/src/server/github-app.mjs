import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export function requireGitHubAppConfig(env = process.env) {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const appSlug = env.GITHUB_APP_SLUG;
  if (!appId || !privateKey || !appSlug) {
    throw Object.assign(new Error("GitHub App is not configured."), {
      code: "GITHUB_APP_NOT_CONFIGURED",
    });
  }
  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    appSlug,
  };
}

export function githubAppInstallUrl({ state, env = process.env }) {
  const { appSlug } = requireGitHubAppConfig(env);
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url;
}

export function createGitHubAppAuth(env = process.env) {
  const config = requireGitHubAppConfig(env);
  return createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
  });
}

export async function createAppOctokit({ env = process.env, authFactory = createGitHubAppAuth } = {}) {
  const auth = authFactory(env);
  const appAuth = await auth({ type: "app" });
  return new Octokit({ auth: appAuth.token });
}

export async function createInstallationOctokit({
  installationId,
  env = process.env,
  authFactory = createGitHubAppAuth,
} = {}) {
  const auth = authFactory(env);
  const installationAuth = await auth({
    type: "installation",
    installationId: Number(installationId),
  });
  return new Octokit({ auth: installationAuth.token });
}

export async function getGitHubInstallation({
  installationId,
  appOctokit = null,
  env = process.env,
  authFactory = createGitHubAppAuth,
} = {}) {
  const octokit = appOctokit ?? (await createAppOctokit({ env, authFactory }));
  const response = await octokit.apps.getInstallation({
    installation_id: Number(installationId),
  });
  return response.data;
}

export async function listInstallationRepositories({
  installationId,
  octokit = null,
  env = process.env,
  authFactory = createGitHubAppAuth,
} = {}) {
  const installationOctokit =
    octokit ?? (await createInstallationOctokit({ installationId, env, authFactory }));
  const repositories = await installationOctokit.paginate(
    installationOctokit.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );
  return repositories.map(safeGitHubRepository);
}

export function safeGitHubRepository(repository) {
  return {
    githubRepositoryId: String(repository.id),
    fullName: repository.full_name,
    name: repository.name,
    ownerLogin: repository.owner?.login ?? repository.full_name?.split("/")?.[0] ?? null,
    defaultBranch: repository.default_branch || "main",
    private: Boolean(repository.private),
  };
}

export function findRepositoryById(repositories, repositoryId) {
  const wanted = String(repositoryId);
  return repositories.find((repository) => String(repository.githubRepositoryId) === wanted) ?? null;
}
