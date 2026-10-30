import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { removeCustomDomain, customDomainErrorResponse } from "@/src/server/customer-custom-domain.mjs";

export const dynamic = "force-dynamic";

// Removes the app's custom domain (the engine takes it off the app).
export async function POST(_request, { params }) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    return Response.json(await removeCustomDomain(db, { customerId: session.customerId, workspaceId, appId }));
  } catch (error) {
    return customDomainErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
