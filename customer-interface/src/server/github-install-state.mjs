import { randomBytes } from "node:crypto";
import Iron from "@hapi/iron";
import { requireSessionSecret } from "./session.mjs";

export const githubInstallStateCookieName = "utplava_github_install_state";

export function createGitHubInstallNonce() {
  return randomBytes(24).toString("base64url");
}

export async function sealGitHubInstallState(payload, secret = requireSessionSecret()) {
  return Iron.seal(
    {
      state: payload.state,
      customerId: payload.customerId,
      workspaceId: payload.workspaceId,
      issuedAt: Date.now(),
    },
    secret,
    Iron.defaults,
  );
}

export async function unsealGitHubInstallState(value, secret = requireSessionSecret()) {
  if (!value) return null;
  try {
    const state = await Iron.unseal(value, secret, Iron.defaults);
    if (!state?.state || !state?.customerId || !state?.workspaceId) return null;
    return state;
  } catch {
    return null;
  }
}

export function githubInstallStateCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  };
}

export function clearGitHubInstallStateCookieOptions() {
  return {
    path: "/",
    maxAge: 0,
  };
}

export function githubInstallCallbackRedirectPath(searchParams) {
  const state = typeof searchParams?.state === "string" ? searchParams.state : null;
  const installationId =
    typeof searchParams?.installation_id === "string" ? searchParams.installation_id : null;
  const setupAction =
    typeof searchParams?.setup_action === "string" ? searchParams.setup_action : null;

  if (!state && !installationId && !setupAction) return null;
  const callback = new URLSearchParams();
  if (state) callback.set("state", state);
  if (installationId) callback.set("installation_id", installationId);
  if (setupAction) callback.set("setup_action", setupAction);
  return `/api/github/install/callback?${callback.toString()}`;
}
