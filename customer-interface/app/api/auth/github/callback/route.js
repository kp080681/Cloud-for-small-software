import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import {
  exchangeGitHubCodeForToken,
  fetchGitHubUser,
  githubRedirectUri,
} from "@/src/server/github-oauth.mjs";
import {
  clearCookieOptions,
  oauthStateCookieName,
  sealSession,
  selectedWorkspaceCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from "@/src/server/session.mjs";
import {
  defaultWorkspaceName,
  ensureInitialWorkspace,
  upsertCustomerIdentity,
} from "@/src/server/customer-workspaces.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();
  const expectedState = store.get(oauthStateCookieName)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return Response.redirect(new URL("/?auth=failed", request.url));
  }

  let db;
  try {
    const accessToken = await exchangeGitHubCodeForToken({
      code,
      redirectUri: githubRedirectUri(request),
    });
    const githubUser = await fetchGitHubUser({ accessToken });
    db = await connectDatabase();
    const identity = await upsertCustomerIdentity(db, githubUser);
    const workspace = await ensureInitialWorkspace(db, {
      customerId: identity.id,
      workspaceName: defaultWorkspaceName(githubUser),
    });
    const session = await sealSession({
      customerId: identity.id,
      provider: identity.provider,
      login: identity.login,
      name: identity.display_name ?? identity.login,
      avatarUrl: identity.avatar_url ?? null,
    });

    store.set(sessionCookieName, session, sessionCookieOptions());
    store.set(selectedWorkspaceCookieName, workspace.id, sessionCookieOptions());
    store.set(oauthStateCookieName, "", clearCookieOptions());
    return Response.redirect(new URL(`/?workspace=${encodeURIComponent(workspace.id)}`, request.url));
  } catch {
    return Response.redirect(new URL("/?auth=failed", request.url));
  } finally {
    if (db) await db.end();
  }
}
