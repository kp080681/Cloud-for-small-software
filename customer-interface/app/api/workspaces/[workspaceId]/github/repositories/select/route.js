import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { selectWorkspaceRepository } from "@/src/server/customer-github.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    const body = await request.json();
    db = await connectDatabase();
    const repository = await selectWorkspaceRepository(db, {
      customerId: session.customerId,
      workspaceId,
      installationId: body?.installationId,
      repositoryId: body?.repositoryId,
    });
    return Response.json({ repository });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
