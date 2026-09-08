import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import {
  analyzeSelectedRepository,
  safeRepositoryAnalysisError,
} from "@/src/server/repository-analysis.mjs";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  let db;
  try {
    const { workspaceId, repositoryId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    const analysis = await analyzeSelectedRepository(db, {
      customerId: session.customerId,
      workspaceId,
      repositoryId,
    });
    return Response.json({ analysis });
  } catch (error) {
    const body = safeRepositoryAnalysisError(error);
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return Response.json(body, { status });
  } finally {
    if (db) await db.end();
  }
}
