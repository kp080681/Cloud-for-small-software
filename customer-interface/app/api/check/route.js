import { connectDatabase } from "@/src/server/db.mjs";
import { CheckError, normalizeTarget, runAppCheck } from "@/src/server/app-check.mjs";
import { consumeCheckAllowance, visitorKey } from "@/src/server/app-check-limits.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Free App safety check for utplava.dev/check. Signed-out, read-only, and
// nothing about the scan is stored (only a hashed per-hour counter).
const ALLOWED_ORIGINS = new Set(["https://utplava.dev", "https://www.utplava.dev", "https://app.utplava.dev"]);

function cors(request) {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://utplava.dev",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

export async function GET(request) {
  const headers = cors(request);
  const input = new URL(request.url).searchParams.get("url");
  try {
    normalizeTarget(input); // reject bad input before spending an allowance
  } catch (error) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status || 400, headers });
  }
  let db;
  try {
    db = await connectDatabase();
    const allowance = await consumeCheckAllowance(db, visitorKey(request));
    if (!allowance.allowed) {
      const message =
        allowance.reason === "global"
          ? "Lots of people are checking apps right now. Try again in a few minutes."
          : "You've run 5 checks this hour. Try again a little later.";
      return Response.json({ error: "RATE_LIMITED", message }, { status: 429, headers: { ...headers, "Retry-After": String(allowance.retryAfterSeconds) } });
    }
  } catch {
    return Response.json({ error: "UNAVAILABLE", message: "The checker is unavailable right now. Try again shortly." }, { status: 503, headers });
  } finally {
    if (db) await db.end().catch(() => {});
  }
  try {
    const result = await runAppCheck(input);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof CheckError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers });
    return Response.json({ error: "CHECK_FAILED", message: "The check couldn't finish. Try again in a minute." }, { status: 500, headers });
  }
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: cors(request) });
}
