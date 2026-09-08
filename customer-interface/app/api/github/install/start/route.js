import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { getAuthorizedWorkspace } from "@/src/server/customer-workspaces.mjs";
import { githubAppInstallUrl } from "@/src/server/github-app.mjs";
import {
  createGitHubInstallNonce,
  githubInstallStateCookieName,
  githubInstallStateCookieOptions,
  sealGitHubInstallState,
} from "@/src/server/github-install-state.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function POST(request) {
  let db;
  try {
    const store = await cookies();
    const session = await requireCustomerSession(store);
    const form = await request.formData();
    const workspaceId = String(form.get("workspaceId") || "");
    db = await connectDatabase();
    await getAuthorizedWorkspace(db, { customerId: session.customerId, workspaceId });

    const state = createGitHubInstallNonce();
    const sealed = await sealGitHubInstallState({
      state,
      customerId: session.customerId,
      workspaceId,
    });
    store.set(githubInstallStateCookieName, sealed, githubInstallStateCookieOptions());
    return Response.redirect(githubAppInstallUrl({ state }));
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
