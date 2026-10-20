import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { requestCustomerAppDeletion } from "@/src/server/customer-app-deletion.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    const body = await request.json().catch(() => ({}));
    db = await connectDatabase();
    const result = await requestCustomerAppDeletion(db, {
      customerId: session.customerId,
      workspaceId,
      appId,
      confirmName: body?.confirmName,
    });
    return Response.json(result);
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
