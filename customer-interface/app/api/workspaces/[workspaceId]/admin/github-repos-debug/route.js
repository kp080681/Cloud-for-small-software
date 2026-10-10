import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { listWorkspaceInstallationRepositories } from "@/src/server/customer-github.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// Temporary operator diagnostic: runs the exact same GitHub App repository
// listing the dashboard's repo picker uses, from inside the live app (where
// the real GitHub App credentials actually live), and surfaces the raw
// installation/repository data plus a direct search for a given name so we
// can see precisely what GitHub returns without guessing from the UI.
// Safe to delete once the "missing repo" question is resolved.
export async function GET(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const data = await listWorkspaceInstallationRepositories(db, {
      customerId: session.customerId,
      workspaceId,
    });

    const search = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? null;
    const flatRepos = data.installations.flatMap((group) =>
      (group.repositories ?? []).map((r) => ({
        installationId: group.installation.githubInstallationId,
        accountLogin: group.installation.accountLogin,
        ...r,
      })),
    );

    return Response.json({
      connectionStatus: data.connectionStatus,
      installationCount: data.installations.length,
      installations: data.installations.map((g) => ({
        installationId: g.installation.githubInstallationId,
        accountLogin: g.installation.accountLogin,
        accountType: g.installation.accountType,
        error: g.error ?? null,
        repositoryCount: g.repositories?.length ?? 0,
      })),
      totalRepositoryCount: flatRepos.length,
      matches: search ? flatRepos.filter((r) => r.fullName?.toLowerCase().includes(search) || r.name?.toLowerCase().includes(search)) : undefined,
      allRepoNames: flatRepos.map((r) => r.fullName),
    });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
