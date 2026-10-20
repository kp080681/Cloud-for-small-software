// Push-to-deploy (2026-10-20): a verified GitHub push to an app's main
// branch redeploys that app with no click. Follows the design in
// docs/02-v1-architecture/GITHUB-INTEGRATION.md:
//   - authenticate every delivery with the webhook secret BEFORE parsing it
//   - record each delivery by GitHub's delivery id (UNIQUE) so a retried
//     delivery can never start a second deployment
//   - resolve the app by GitHub's stable repository id + installation id,
//     never by repository name
// and reuses the exact analyse -> start path the dashboard buttons use, so
// every existing guard (failure cooldown/pause, rate limits, readiness and
// missing-configuration blocking) applies to pushes too.

import crypto from "node:crypto";
import { analyzeSelectedRepository } from "./repository-analysis.mjs";
import { startCustomerDeployment } from "./customer-deployments.mjs";

const ZERO_SHA = /^0+$/;

// A deployment counts as "running" once it has actually been started
// (orchestrator run recorded) and is not finished. Only ones touched in
// the last 30 minutes count, so a long-dead stuck row can't block every
// future push forever.
const RUNNING_DEPLOYMENT_SQL = `
  SELECT id
    FROM deployments
   WHERE app_id = $1
     AND updated_at > now() - interval '30 minutes'
     AND (
       status IN ('QUEUED','PROVISIONING','BUILDING','DEPLOYING','HEALTH_CHECKING')
       OR (status = 'ANALYZING' AND orchestrator_run_id IS NOT NULL)
     )
   LIMIT 1`;

export function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"),
    "utf8",
  );
  const received = Buffer.from(signatureHeader, "utf8");
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export function parsePushEvent(payload) {
  return {
    ref: typeof payload?.ref === "string" ? payload.ref : null,
    after: typeof payload?.after === "string" ? payload.after : null,
    deleted: Boolean(payload?.deleted),
    installationId: Number.isFinite(Number(payload?.installation?.id)) ? Number(payload.installation.id) : null,
    repositoryId: Number.isFinite(Number(payload?.repository?.id)) ? Number(payload.repository.id) : null,
  };
}

// Returns { duplicate: true } when GitHub has already delivered this one.
export async function recordWebhookDelivery(db, { deliveryId, eventType, push }) {
  const result = await db.query(
    `INSERT INTO github_webhook_deliveries
       (delivery_id, event_type, github_installation_id, github_repository_id, ref, after_sha)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING id`,
    [deliveryId, eventType, push?.installationId ?? null, push?.repositoryId ?? null, push?.ref ?? null, push?.after ?? null],
  );
  return result.rowCount === 1 ? { duplicate: false, id: result.rows[0].id } : { duplicate: true, id: null };
}

export async function finishWebhookDelivery(db, id, status, detail = null) {
  await db.query(
    `UPDATE github_webhook_deliveries SET status=$2, detail=$3, processed_at=now() WHERE id=$1`,
    [id, status, detail],
  );
}

async function loadPushTargets(db, { repositoryId, installationId }) {
  const result = await db.query(
    `SELECT a.id AS app_id,
            a.workspace_id,
            a.auto_deploy_on_push,
            r.id AS repository_id,
            r.default_branch,
            EXISTS (SELECT 1 FROM deployments d WHERE d.app_id = a.id AND d.status = 'LIVE') AS has_live,
            (SELECT m.customer_identity_id
               FROM customer_workspace_memberships m
              WHERE m.workspace_id = a.workspace_id AND m.role = 'owner'
              ORDER BY m.created_at ASC
              LIMIT 1) AS owner_customer_id
       FROM github_repositories r
       JOIN github_installations gi ON gi.id = r.github_installation_id
       JOIN workspace_github_installations wgi
         ON wgi.workspace_id = r.workspace_id
        AND wgi.github_installation_id = r.github_installation_id
       JOIN apps a ON a.repository_id = r.id AND a.deleted_at IS NULL
      WHERE r.github_repository_id = $1
        AND gi.github_installation_id = $2`,
    [repositoryId, installationId],
  );
  return result.rows;
}

async function waitForRunningDeployment(db, appId, { maxWaitMs, pollMs, sleep }) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const running = await db.query(RUNNING_DEPLOYMENT_SQL, [appId]);
    if (running.rowCount === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

function classifyStartError(error) {
  const code = String(error?.code ?? "");
  if (error?.name === "AppPausedError" || code === "APP_PAUSED") return "paused";
  if (code.includes("RATE_LIMIT")) return "rate_limited";
  if (code === "DEPLOYMENT_NOT_READY" || code.includes("CONFIGURATION") || code === "ANALYSIS_REQUIRED") return "needs_configuration";
  return "failed";
}

async function deployTarget(db, target, push, deps) {
  if (push.ref !== `refs/heads/${target.default_branch}`) return "not_main_branch";
  if (!target.auto_deploy_on_push) return "auto_deploy_off";
  // An app's very first deployment stays a deliberate, manual step.
  if (!target.has_live) return "not_yet_live";
  if (!target.owner_customer_id) return "no_owner";

  // Never run two deployments of one app at once: an older build finishing
  // after a newer one would put old code back live. Wait for any running
  // deployment to finish first. Analysis then reads the branch's CURRENT
  // head, so a burst of pushes deploys only the newest commit; the others
  // reuse that same deployment (deployments are unique per app+commit).
  const clear = await waitForRunningDeployment(db, target.app_id, deps);
  if (!clear) return "queued_timeout";

  const analysis = await deps.analyze(db, {
    customerId: target.owner_customer_id,
    workspaceId: target.workspace_id,
    repositoryId: target.repository_id,
    deploymentReason: "push",
  });
  if (!analysis.supported) return "unsupported";

  try {
    const started = await deps.start(db, {
      customerId: target.owner_customer_id,
      workspaceId: target.workspace_id,
      appId: analysis.appId,
      deploymentId: analysis.deploymentId,
    });
    return started?.start?.started ? "deploying" : "already_deployed";
  } catch (error) {
    return classifyStartError(error);
  }
}

export async function processPushDelivery(
  db,
  push,
  {
    analyze = analyzeSelectedRepository,
    start = startCustomerDeployment,
    maxWaitMs = 240_000,
    pollMs = 5_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!push.ref || !push.ref.startsWith("refs/heads/")) return { status: "ignored", detail: "not_a_branch_push" };
  if (push.deleted || !push.after || ZERO_SHA.test(push.after)) return { status: "ignored", detail: "branch_deleted" };
  if (!push.repositoryId || !push.installationId) return { status: "ignored", detail: "missing_repository_or_installation" };

  const targets = await loadPushTargets(db, push);
  if (!targets.length) return { status: "ignored", detail: "no_app_for_repository" };

  const outcomes = [];
  for (const target of targets) {
    let outcome;
    try {
      outcome = await deployTarget(db, target, push, { analyze, start, maxWaitMs, pollMs, sleep });
    } catch (error) {
      outcome = `failed:${String(error?.code ?? error?.name ?? "error")}`;
    }
    outcomes.push(`${target.app_id}=${outcome}`);
  }
  const deploying = outcomes.some((o) => o.endsWith("=deploying"));
  return { status: deploying ? "deploying" : "processed", detail: outcomes.join(" ") };
}
