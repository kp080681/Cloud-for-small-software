import { connectDatabase } from "@/src/server/db.mjs";
import { RegistrationError, registerMcpClient } from "@/src/server/mcp-registration.mjs";

export const dynamic = "force-dynamic";

// RFC 7591 registration endpoint. Unauthenticated by design (that is the
// standard); see mcp-registration.mjs for why that grants nothing on its own.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

export async function POST(request) {
  let db;
  try {
    const body = await request.json().catch(() => null);
    db = await connectDatabase();
    const registered = await registerMcpClient(db, body);
    return Response.json(registered, { status: 201, headers: CORS });
  } catch (error) {
    if (error instanceof RegistrationError) {
      return Response.json({ error: error.error, error_description: error.message }, { status: error.status, headers: CORS });
    }
    return Response.json({ error: "server_error", error_description: "Registration failed." }, { status: 500, headers: CORS });
  } finally {
    if (db) await db.end();
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
