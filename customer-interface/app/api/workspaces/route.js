import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import {
  defaultWorkspaceName,
  ensureInitialWorkspace,
  listAuthorizedWorkspaces,
} from "@/src/server/customer-workspaces.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  let db;
  try {
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    await ensureInitialWorkspace(db, {
      customerId: session.customerId,
      workspaceName: defaultWorkspaceName(session),
    });
    const workspaces = await listAuthorizedWorkspaces(db, { customerId: session.customerId });
    return Response.json({ workspaces });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
