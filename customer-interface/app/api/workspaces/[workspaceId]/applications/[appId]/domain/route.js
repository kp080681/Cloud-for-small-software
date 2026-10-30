import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { connectCustomDomain, getAppCustomDomain, customDomainErrorResponse } from "@/src/server/customer-custom-domain.mjs";

export const dynamic = "force-dynamic";

// The app's custom domain: GET its status, POST { domain } to connect one,
// POST …/domain/remove to remove it. Provider work happens in the engine.
async function withSession(params, work) {
  let db;
  try {
    const { workspaceId, appId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    return Response.json(await work(db, { customerId: session.customerId, workspaceId, appId }));
  } catch (error) {
    return customDomainErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}

export async function GET(_request, { params }) {
  return withSession(params, (db, identity) => getAppCustomDomain(db, identity));
}

export async function POST(request, { params }) {
  const body = await request.json().catch(() => ({}));
  return withSession(params, (db, identity) => connectCustomDomain(db, { ...identity, domain: body?.domain }));
}

