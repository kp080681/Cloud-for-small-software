import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { revealAppDatabaseConnection } from "@/src/server/customer-app-database.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// POST, not GET: revealing a credential is an action, never cached or prefetched.
export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const result = await revealAppDatabaseConnection(db, { customerId: session.customerId, workspaceId, appId });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
