import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { listTokenFamilies } from "@/src/server/mcp-auth.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// Lists the AI clients that hold MCP grants for this workspace, so a
// customer can actually find the tokenFamilyId that ../revoke needs.
// Added after an independent review (Opus 5.5) pointed out that
// revokeTokenFamily already existed and was already correctly
// tenant-scoped, but nothing anywhere ever surfaced a token family's id
// to a customer — meaning a compromised or unwanted grant was effectively
// unrevokable in practice, even though the underlying revoke logic worked.
// This is API-only; a dashboard screen to actually click "revoke" from is
// still real UI work, not done here.
export async function GET(_request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const grants = await listTokenFamilies(db, { customerId: session.customerId, workspaceId });
    return Response.json({ grants });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
