import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { revokeTokenFamily } from "@/src/server/mcp-auth.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// Customer-facing revoke, reachable only through the existing cookie
// session — a customer revoking an MCP grant for one of their own
// workspaces. workspaceId comes from the URL, matching every other
// workspace-scoped mutation in this codebase; tokenFamilyId comes from the
// body. revokeTokenFamily itself re-checks both against customerId before
// touching anything, so a customer can't revoke a grant that isn't theirs
// just by guessing or supplying someone else's ids here.
export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const body = await request.json().catch(() => ({}));
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const result = await revokeTokenFamily(db, {
      customerId: session.customerId,
      workspaceId,
      tokenFamilyId: body.tokenFamilyId,
    });
    return Response.json(result);
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
