import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { connectGitHubInstallationToWorkspace } from "@/src/server/customer-github.mjs";
import {
  clearGitHubInstallStateCookieOptions,
  githubInstallStateCookieName,
  unsealGitHubInstallState,
} from "@/src/server/github-install-state.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const url = new URL(request.url);
  const queryState = url.searchParams.get("state");
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");
  const store = await cookies();
  const sealedState = store.get(githubInstallStateCookieName)?.value;
  const installState = await unsealGitHubInstallState(sealedState);

  if (setupAction === "cancel" || setupAction === "cancelled") {
    store.set(githubInstallStateCookieName, "", clearGitHubInstallStateCookieOptions());
    return Response.redirect(new URL("/?github=cancelled", request.url));
  }

  if (!queryState || !installationId || !installState || queryState !== installState.state) {
    return Response.redirect(new URL("/?github=invalid", request.url));
  }

  let db;
  try {
    const session = await requireCustomerSession(store);
    if (session.customerId !== installState.customerId) {
      return Response.redirect(new URL("/?github=invalid", request.url));
    }

    db = await connectDatabase();
    await connectGitHubInstallationToWorkspace(db, {
      customerId: session.customerId,
      workspaceId: installState.workspaceId,
      installationId,
    });
    store.set(githubInstallStateCookieName, "", clearGitHubInstallStateCookieOptions());
    return Response.redirect(
      new URL(`/?workspace=${encodeURIComponent(installState.workspaceId)}&github=connected`, request.url),
    );
  } catch {
    return Response.redirect(new URL("/?github=failed", request.url));
  } finally {
    if (db) await db.end();
  }
}
