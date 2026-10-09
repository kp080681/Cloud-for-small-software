import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { getAuthorizedWorkspace } from "@/src/server/customer-workspaces.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// One-off operator utility: lets an authenticated workspace owner raise their
// own maxActiveApps/maxActiveDeployments ceiling, reusing the exact
// connectDatabase()/session path the rest of the app already relies on. This
// exists because the admin scripts that would normally do this need direct
// database credentials the operator doesn't have readily on hand locally;
// this route needs none, since it runs inside the already-authenticated,
// already-connected app. Not wired into any UI; hit it directly as the
// signed-in workspace owner.
export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    await getAuthorizedWorkspace(db, { customerId: session.customerId, workspaceId });

    const body = await request.json().catch(() => ({}));
    const maxActiveApps = Number.isInteger(body?.maxActiveApps) ? body.maxActiveApps : 25;
    const maxActiveDeployments = Number.isInteger(body?.maxActiveDeployments) ? body.maxActiveDeployments : 25;
    if (maxActiveApps < 0 || maxActiveApps > 50 || maxActiveDeployments < 0 || maxActiveDeployments > 50) {
      return Response.json({ error: "RESOURCE_POLICY_VALUE_OUT_OF_RANGE" }, { status: 400 });
    }

    const result = await db.query(
      `INSERT INTO workspace_resource_policies
         (workspace_id, max_active_apps, max_active_deployments, max_active_deployments_per_app, max_concurrent_provider_operations, max_managed_databases)
       VALUES ($1,$2,$3,1,2,3)
       ON CONFLICT (workspace_id) DO UPDATE SET
         max_active_apps = EXCLUDED.max_active_apps,
         max_active_deployments = EXCLUDED.max_active_deployments,
         updated_at = now()
       RETURNING workspace_id, max_active_apps, max_active_deployments, max_active_deployments_per_app, max_concurrent_provider_operations, max_managed_databases, updated_at`,
      [workspaceId, maxActiveApps, maxActiveDeployments],
    );

    return Response.json({ result: "WORKSPACE_RESOURCE_POLICY_UPDATED", policy: result.rows[0] });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
