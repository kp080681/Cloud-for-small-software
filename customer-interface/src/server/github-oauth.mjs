import { randomBytes } from "node:crypto";

const githubAuthorizeUrl = "https://github.com/login/oauth/authorize";
const githubTokenUrl = "https://github.com/login/oauth/access_token";
const githubUserUrl = "https://api.github.com/user";

export function createOAuthState() {
  return randomBytes(24).toString("base64url");
}

export function githubRedirectUri(request) {
  return new URL("/api/auth/github/callback", request.url).toString();
}

export function githubOAuthConfig(env = process.env) {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error("GitHub OAuth is not configured."), {
      code: "GITHUB_OAUTH_NOT_CONFIGURED",
    });
  }
  return { clientId, clientSecret };
}

export function githubAuthorizationUrl({ state, redirectUri, env = process.env }) {
  const { clientId } = githubOAuthConfig(env);
  const url = new URL(githubAuthorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");
  return url;
}

export async function exchangeGitHubCodeForToken({ code, redirectUri, env = process.env, fetchImpl = fetch }) {
  const { clientId, clientSecret } = githubOAuthConfig(env);
  const response = await fetchImpl(githubTokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw Object.assign(new Error("GitHub OAuth token exchange failed."), {
      code: "GITHUB_OAUTH_TOKEN_FAILED",
    });
  }

  const body = await response.json();
  if (!body?.access_token) {
    throw Object.assign(new Error("GitHub OAuth token exchange returned no token."), {
      code: "GITHUB_OAUTH_TOKEN_MISSING",
    });
  }
  return body.access_token;
}

export function normalizeGitHubUser(user) {
  if (!user?.id || !user?.login) {
    throw Object.assign(new Error("GitHub user response was incomplete."), {
      code: "GITHUB_USER_INCOMPLETE",
    });
  }
  return {
    provider: "github",
    providerAccountId: String(user.id),
    login: user.login,
    displayName: user.name ?? user.login,
    avatarUrl: user.avatar_url ?? null,
  };
}

export async function fetchGitHubUser({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(githubUserUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw Object.assign(new Error("GitHub user lookup failed."), {
      code: "GITHUB_USER_LOOKUP_FAILED",
    });
  }
  return normalizeGitHubUser(await response.json());
}
