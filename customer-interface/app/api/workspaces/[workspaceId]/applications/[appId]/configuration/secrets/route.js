import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { saveCustomerAppSecret } from "@/src/server/customer-configuration.mjs";
import { continueReleasedDeployment } from "@/src/server/customer-deployments.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    const body = await request.json();
    db = await connectDatabase();
    const result = await saveCustomerAppSecret(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
      envKey: body?.envKey,
      plaintext: body?.value,
    });
    const deployment = await continueReleasedDeployment(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
      deploymentId: result.releasedDeploymentId,
    });
    return Response.json({ ...result, deploymentContinued: deployment.continued });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
