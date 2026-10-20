import { after } from "next/server";
import { connectDatabase } from "@/src/server/db.mjs";
import {
  finishWebhookDelivery,
  parsePushEvent,
  processPushDelivery,
  recordWebhookDelivery,
  verifyGithubSignature,
} from "@/src/server/github-push-deploy.mjs";

export const dynamic = "force-dynamic";
// The push work (analyse + start, and waiting out a deploy that's already
// running) happens after the response, inside this function's lifetime.
export const maxDuration = 300;

// GitHub App webhook endpoint. GitHub expects a quick answer (it gives up
// after 10s), so this only authenticates, de-duplicates and records the
// delivery, then answers 202 and does the deploy work in after().
export async function POST(request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "webhook_not_configured" }, { status: 503 });

  // Raw body first: the signature covers the exact bytes GitHub sent.
  const rawBody = await request.text();
  if (!verifyGithubSignature(rawBody, request.headers.get("x-hub-signature-256"), secret)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  const eventType = request.headers.get("x-github-event") || "";
  const deliveryId = request.headers.get("x-github-delivery") || "";
  if (eventType === "ping") return Response.json({ ok: true, pong: true });
  if (eventType !== "push") return Response.json({ ok: true, ignored: eventType }, { status: 202 });
  if (!deliveryId) return Response.json({ error: "missing_delivery_id" }, { status: 400 });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const push = parsePushEvent(payload);

  let delivery;
  const db = await connectDatabase();
  try {
    delivery = await recordWebhookDelivery(db, { deliveryId, eventType, push });
  } finally {
    await db.end();
  }
  if (delivery.duplicate) return Response.json({ ok: true, duplicate: true });

  after(async () => {
    const workDb = await connectDatabase();
    try {
      const result = await processPushDelivery(workDb, push);
      await finishWebhookDelivery(workDb, delivery.id, result.status, result.detail);
    } catch (error) {
      console.error("github_push_deploy_failed", { deliveryId, code: error?.code ?? null, name: error?.name ?? null });
      await finishWebhookDelivery(workDb, delivery.id, "failed", String(error?.code ?? error?.name ?? "error")).catch(() => {});
    } finally {
      await workDb.end();
    }
  });

  return Response.json({ ok: true, accepted: true }, { status: 202 });
}
