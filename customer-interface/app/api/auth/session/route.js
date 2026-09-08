import { cookies } from "next/headers";
import { publicSession } from "@/src/server/session.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireCustomerSession(await cookies());
    return Response.json(publicSession(session));
  } catch (error) {
    return safeErrorResponse(error);
  }
}
