import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { setAppAutoDeployOnPush } from "@/src/server/customer-workspaces.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    const body = await request.json();
    db = await connectDatabase();
    const result = await setAppAutoDeployOnPush(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
      enabled: body?.enabled,
    });
    return Response.json(result);
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
