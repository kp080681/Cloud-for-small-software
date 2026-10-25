import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { redeployLiveCustomerApp } from "@/src/server/customer-deployments.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// One-click rollback: put an earlier live version back. Same checks as a
// redeploy (see redeployLiveCustomerApp's rollbackToDeploymentId).
export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    const body = await request.json().catch(() => ({}));
    if (typeof body?.deploymentId !== "string" || !body.deploymentId) {
      return Response.json({ error: "ROLLBACK_TARGET_NOT_FOUND" }, { status: 400 });
    }
    db = await connectDatabase();
    const deployment = await redeployLiveCustomerApp(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
      rollbackToDeploymentId: body.deploymentId,
    });
    return Response.json({ deploymentId: deployment.deploymentId, status: deployment.status });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
