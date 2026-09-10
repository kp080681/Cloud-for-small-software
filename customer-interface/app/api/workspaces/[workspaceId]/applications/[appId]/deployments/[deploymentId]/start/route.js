import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { startCustomerDeployment } from "@/src/server/customer-deployments.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  let db;
  try {
    const { workspaceId, appId, deploymentId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const deployment = await startCustomerDeployment(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
      deploymentId,
    });
    return Response.json({ deployment });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
