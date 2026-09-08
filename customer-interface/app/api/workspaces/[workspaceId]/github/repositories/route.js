import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { listWorkspaceInstallationRepositories } from "@/src/server/customer-github.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const repositories = await listWorkspaceInstallationRepositories(db, {
      customerId: session.customerId,
      workspaceId,
    });
    return Response.json(repositories);
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
