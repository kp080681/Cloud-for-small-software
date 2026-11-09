import { connectDatabase } from "@/src/server/db.mjs";
import { recordFunnelStep } from "@/src/server/mcp-funnel.mjs";
import { allowTryEvent } from "@/src/server/try-repo-check.mjs";

export const dynamic = "force-dynamic";

const STEPS = new Set(["try_previewed", "try_publish_clicked", "try_published"]);

// Counts how far visitors get with "try before sign-in". Only the step
// name is recorded, with the label "web": nothing about the visitor or
// what they pasted.
export async function POST(request) {
  let db;
  try {
    const body = await request.json().catch(() => ({}));
    if (!STEPS.has(body?.step)) return new Response(null, { status: 204 });
    db = await connectDatabase();
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || request.headers.get("x-real-ip");
    if (await allowTryEvent(db, { ip })) await recordFunnelStep(db, { step: body.step, client: "web" });
  } catch {
    // counting never affects the page
  } finally {
    if (db) await db.end().catch(() => {});
  }
  return new Response(null, { status: 204 });
}
