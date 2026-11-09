import { connectDatabase } from "@/src/server/db.mjs";
import { recordFunnelStep } from "@/src/server/mcp-funnel.mjs";
import { TryError, checkPublicRepository, enforceTryLimits, parseRepoInput } from "@/src/server/try-repo-check.mjs";

export const dynamic = "force-dynamic";

// Signed-out visitors: is this public GitHub repository something Utplava
// can run? Reads only public metadata; see src/server/try-repo-check.mjs.
export async function POST(request) {
  let db;
  try {
    const raw = await request.text();
    if (raw.length > 2000) throw new TryError("TRY_BAD_REQUEST", "Paste just the repository link.");
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      throw new TryError("TRY_BAD_REQUEST", "Paste just the repository link.");
    }
    const target = parseRepoInput(body?.repo);
    if (!target) {
      throw new TryError("TRY_BAD_LINK", "That doesn't look like a GitHub repository link. It should look like github.com/your-name/your-app.");
    }
    db = await connectDatabase();
    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || request.headers.get("x-real-ip");
    await enforceTryLimits(db, { ip });
    const result = await checkPublicRepository(target);
    await recordFunnelStep(db, { step: "try_repo_checked", client: `web (${result.status})` });
    return Response.json(result);
  } catch (error) {
    if (error instanceof TryError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    console.error("try_repo_check_failed", JSON.stringify({ status: Number(error?.status) || undefined, message: String(error?.message ?? "").slice(0, 300) }));
    return Response.json(
      { error: { code: "TRY_FAILED", message: "Utplava couldn't check that repository just now. Sign in and pick it from your list instead." } },
      { status: 502 },
    );
  } finally {
    if (db) await db.end();
  }
}
