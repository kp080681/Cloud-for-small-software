// One-off diagnostic: calls Trigger.dev's own task-trigger endpoint
// directly, with no wrapping, so the real response status and body are
// visible — triggerDeploymentOrchestrator in customer-deployments.mjs
// discards both before throwing a generic 502, which is exactly what's
// hiding the real cause of a persistent (not transient) failure here.
const secret = process.env.TRIGGER_SECRET_KEY;
if (!secret) throw new Error("Missing TRIGGER_SECRET_KEY");

const taskId = "ssc-control-plane-orchestrate-deployment";
const baseUrl = (process.env.TRIGGER_API_URL || "https://api.trigger.dev").replace(/\/$/, "");

const response = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "x-trigger-api-version": "2025-07-16",
    "x-trigger-source": "utplava-customer-interface-diagnostic",
  },
  body: JSON.stringify({
    payload: { deploymentId: "00000000-0000-0000-0000-000000000000" },
    options: { payloadType: "application/json", idempotencyKey: `diagnostic-${Date.now()}`, tags: ["diagnostic"] },
  }),
});

const text = await response.text();
console.log("status:", response.status, response.statusText);
console.log("body:", text);
