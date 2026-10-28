import { connectDatabase } from "@/src/server/db.mjs";
import { consumeCheckAllowance, visitorKey } from "@/src/server/app-check-limits.mjs";
import { HelpRequestError, saveHelpRequest, validateHelpRequest } from "@/src/server/app-check-help.mjs";

export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://utplava.dev", "https://www.utplava.dev", "https://app.utplava.dev"]);

function cors(request) {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://utplava.dev",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

export async function POST(request) {
  const headers = cors(request);
  let parsed;
  try {
    parsed = validateHelpRequest(await request.json().catch(() => null));
  } catch (error) {
    const message = error instanceof HelpRequestError ? error.message : "Something went wrong. Try again.";
    return Response.json({ error: "INVALID", message }, { status: 400, headers });
  }
  let db;
  try {
    db = await connectDatabase();
    // Same hourly allowance as checks, counted separately ("h:" key).
    const allowance = await consumeCheckAllowance(db, `h:${visitorKey(request)}`);
    if (!allowance.allowed) {
      return Response.json({ error: "RATE_LIMITED", message: "Thanks, we already have your request. We'll be in touch." }, { status: 429, headers });
    }
    await saveHelpRequest(db, parsed);
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ error: "UNAVAILABLE", message: "Couldn't send that right now. Email contact@dealup.co.in instead." }, { status: 503, headers });
  } finally {
    if (db) await db.end().catch(() => {});
  }
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: cors(request) });
}
