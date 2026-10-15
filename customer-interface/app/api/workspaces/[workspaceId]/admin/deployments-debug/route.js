import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { getAuthorizedWorkspace } from "@/src/server/customer-workspaces.mjs";
import { loadDeploymentsDebug } from "@/src/server/deployments-debug.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// Temporary, read-only operator diagnostic: every app in this workspace with
// its latest deployment and that deployment's event trail, in one call, so a
// "still stuck" report can be checked directly instead of going back and
// forth per app. Deliberately touches no provider credential of any kind --
// DB state only. Superseded for everyday use by the human-readable /debug
// page (no workspace ID to copy, no JSON to paste), kept here for
// programmatic access. Safe to delete once this round of "deployments
// aren't progressing" is resolved.
export async function GET(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    await getAuthorizedWorkspace(db, { customerId: session.customerId, workspaceId });

    const debug = await loadDeploymentsDebug(db, { customerId: session.customerId, workspaceId });
    return Response.json(debug);
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
