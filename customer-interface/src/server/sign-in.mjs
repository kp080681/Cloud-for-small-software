// Shared end of every sign-in (GitHub, Google, reviewer password): save the
// identity, make sure it has a workspace, set the session cookie, and send
// the person back where they were going (the MCP connect flow uses that).

import {
  clearCookieOptions,
  oauthStateCookieName,
  returnToCookieName,
  sealSession,
  selectedWorkspaceCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from "./session.mjs";
import { safeReturnTo } from "./mcp-registration.mjs";
import { ensureInitialWorkspace, upsertCustomerIdentity } from "./customer-workspaces.mjs";

export function workspaceNameFor(identity) {
  const base = String(identity.provider === "github" ? identity.login : identity.displayName || identity.login || "Personal")
    .trim()
    .split("@")[0]
    .slice(0, 48);
  return `${base || "Personal"} workspace`;
}

export async function completeSignIn(db, { store, request, identity, existingIdentityRow = null }) {
  const saved = existingIdentityRow ?? (await upsertCustomerIdentity(db, identity));
  const workspace = await ensureInitialWorkspace(db, {
    customerId: saved.id,
    workspaceName: workspaceNameFor(identity ?? { provider: saved.provider, login: saved.login, displayName: saved.display_name }),
  });
  const session = await sealSession({
    customerId: saved.id,
    provider: saved.provider,
    login: saved.login,
    name: saved.display_name ?? saved.login,
    avatarUrl: saved.avatar_url ?? null,
  });
  store.set(sessionCookieName, session, sessionCookieOptions());
  store.set(selectedWorkspaceCookieName, workspace.id, sessionCookieOptions());
  store.set(oauthStateCookieName, "", clearCookieOptions());
  const returnTo = safeReturnTo(store.get(returnToCookieName)?.value);
  if (returnTo) {
    store.set(returnToCookieName, "", clearCookieOptions());
    return new URL(returnTo, request.url);
  }
  return new URL(`/?workspace=${encodeURIComponent(workspace.id)}`, request.url);
}
