import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { redeployLiveCustomerApp } from "@/src/server/customer-deployments.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

function safeRedeployFailureLog(error, { workspaceId, appId }) {
  const postgres = error?.postgres ?? {};
  console.error("customer_live_redeploy_failed", {
    operation: "customer_live_redeploy",
    code: typeof error?.code === "string" ? error.code : "REQUEST_FAILED",
    stage: error?.redeployStage ?? "unknown",
    workspaceId,
    appId,
    sqlstate: postgres.sqlstate ?? null,
    constraint: postgres.constraint ?? null,
    table: postgres.table ?? null,
    column: postgres.column ?? null,
  });
}

export async function POST(_request, { params }) {
  let db;
  let workspaceId = null;
  let appId = null;
  try {
    ({ workspaceId, appId } = await params);
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const deployment = await redeployLiveCustomerApp(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
    });
    return Response.json({
      deploymentId: deployment.deploymentId,
      status: deployment.status,
      stage: deployment.stage,
      redeploy: deployment.redeploy,
      deployment,
    });
  } catch (error) {
    safeRedeployFailureLog(error, { workspaceId, appId });
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
