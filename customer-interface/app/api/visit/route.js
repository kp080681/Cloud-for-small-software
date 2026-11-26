import { connectDatabase } from "@/src/server/db.mjs";
import { recordSiteVisit, siteVisitLabels } from "@/src/server/site-visits.mjs";
import { allowSiteVisit } from "@/src/server/try-repo-check.mjs";

export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://utplava.dev", "https://www.utplava.dev"]);

function cors(request) {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://utplava.dev",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

// One beacon per visit from utplava.dev: which source tag or referring site
// brought the visitor, and the page they landed on. Only daily counts are
// kept (see src/server/site-visits.mjs); the response is always empty.
export async function POST(request) {
  const headers = cors(request);
  let db;
  try {
    const origin = request.headers.get("origin");
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 204, headers });
    const raw = await request.text();
    if (raw.length > 1500) return new Response(null, { status: 204, headers });
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 204, headers });
    }
    const labels = siteVisitLabels({ ...body, userAgent: request.headers.get("user-agent") });
    if (!labels) return new Response(null, { status: 204, headers });
    db = await connectDatabase();
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || request.headers.get("x-real-ip");
    if (await allowSiteVisit(db, { ip })) await recordSiteVisit(db, labels);
  } catch {
    // counting never affects the page
  } finally {
    if (db) await db.end().catch(() => {});
  }
  return new Response(null, { status: 204, headers });
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: cors(request) });
}
