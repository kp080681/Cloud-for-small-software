import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { publishFiles, safePublishError, PUBLISH_LIMITS } from "@/src/server/direct-publish.mjs";
import { deployRepository } from "@/src/server/mcp-tools.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Base64 makes binary files about a third bigger, plus JSON overhead.
const MAX_BODY_BYTES = Math.ceil(PUBLISH_LIMITS.maxTotalBytes * 1.4) + 64 * 1024;

function tooLarge() {
  return Response.json(
    { error: { code: "PUBLISH_TOO_LARGE", message: "Your files add up to more than 2 MB. Make images smaller, or connect GitHub for a bigger app." } },
    { status: 413 },
  );
}

export async function POST(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());

    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return tooLarge();
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return tooLarge();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: { code: "PUBLISH_BAD_REQUEST", message: "The upload couldn't be read. Please try again." } }, { status: 400 });
    }

    const startedAt = Date.now();
    db = await connectDatabase();
    const published = await publishFiles(db, {
      customerId: session.customerId,
      workspaceId,
      name: typeof body?.name === "string" ? body.name : null,
      appId: typeof body?.appId === "string" && /^[0-9a-f-]{36}$/i.test(body.appId) ? body.appId : null,
      files: body?.files,
      source: "dashboard",
    });
    const result = await deployRepository(db, {
      customerId: session.customerId,
      workspaceId,
      repositoryId: published.repositoryId,
    });
    console.log("direct_publish_done", JSON.stringify({ ms: Date.now() - startedAt, status: result.status, files: published.fileCount }));
    return Response.json({
      appId: result.appId,
      status: result.status,
      message: result.message,
      missingConfig: result.missingConfig ?? [],
      appName: published.appName,
      filesUploaded: published.fileCount,
    });
  } catch (error) {
    const body = safePublishError(error);
    if (body.error.code === "PUBLISH_FAILED") {
      console.error("direct_publish_failed", JSON.stringify({
        name: String(error?.name ?? "").slice(0, 100),
        code: typeof error?.code === "string" ? error.code : undefined,
        status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
        message: String(error?.message ?? "").slice(0, 500),
      }));
    }
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return Response.json(body, { status });
  } finally {
    if (db) await db.end();
  }
}
