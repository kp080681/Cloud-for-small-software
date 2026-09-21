import { getDeploymentReadiness } from "./customer-configuration.mjs";
import { getAuthorizedWorkspace } from "./customer-workspaces.mjs";
import { enforceRateLimit } from "../shared/control-plane/rate-limit.mjs";
import { enforceFailureCooldown } from "../shared/control-plane/deployment-failure-cooldown.mjs";
import crypto from "node:crypto";

const ORCHESTRATOR_TASK_ID = "ssc-control-plane-orchestrate-deployment";
const START_MARKER_PREFIX = "UI06_START_REQUESTED";
const RESUME_MARKER_PREFIX = "UI06_RESUME_REQUESTED";
const ACTIVE_STATUSES = new Set(["ANALYZING", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING"]);
const REDEPLOY_IN_PROGRESS_STATUSES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "ANALYZING",
  "PROVISIONING",
  "BUILDING",
  "DEPLOYING",
  "HEALTH_CHECKING",
  "DELETING",
];
const TERMINAL_STATUSES = new Set(["LIVE", "FAILED", "DELETED"]);
const RESUMABLE_STATUSES = new Set(["ANALYZING", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING"]);
const DEFAULT_RESUME_STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_CUSTOMER_RETRY_DEPTH = 3;
const MAX_RETRY_LINEAGE_TRAVERSAL = 16;

const stageByStatus = Object.freeze({
  ANALYZING: "Looking at your code",
  PROVISIONING: "Setting things up",
  BUILDING: "Building your app",
  DEPLOYING: "Getting your app ready",
  HEALTH_CHECKING: "Making sure it works",
  LIVE: "Live",
  FAILED: "Something went wrong",
  DELETING: "Deleting",
  DELETED: "Deleted",
});

const eventTitles = Object.freeze({
  ENV_REQUIREMENTS_VERIFIED: "Configuration verified",
  DATABASE_READY: "Database ready",
  RUNTIME_RECONCILED: "Runtime ready",
  RUNTIME_PROVISIONED: "Runtime ready",
  RUNTIME_ENV_APPLIED: "Configuration applied",
  BUILD_STARTED: "Build started",
  BUILD_RECOVERY_ATTACHED: "Build recovered",
  BUILD_SUCCEEDED: "Build complete",
  BUILD_FAILED: "Build failed",
  BUILD_TIMEOUT: "Build timed out",
  HEALTH_CHECK_STARTED: "Health checks started",
  HEALTH_CHECK_PASSED: "Health check passed",
  HEALTH_CHECK_FAILED: "Health checks failed",
  PUBLIC_ACCESS_VERIFIED: "Public URL verified",
  PUBLIC_ACCESS_BLOCKED: "Public access blocked",
  DEPLOYMENT_ABANDONED: "Deployment abandoned",
  DEPLOYMENT_RESUME_REQUESTED: "Deployment continuing",
  DEPLOYMENT_RESUME_STARTED: "Deployment continuing",
  DEPLOYMENT_RESUME_FAILED: "Deployment needs attention",
});

const safeEvidenceKeys = new Set([
  "attemptNumber",
  "attempts",
  "attemptsRemaining",
  "checkUrl",
  "configuredCount",
  "created",
  "detectedCount",
  "errorCode",
  "httpStatus",
  "latencyMs",
  "maxBuildMinutes",
  "missingCount",
  "missingKeys",
  "provider",
  "providerDeploymentId",
  "providerDeploymentUrl",
  "providerProjectId",
  "providerProjectName",
  "providerStatus",
  "reconciled",
  "redirectLocationHost",
  "responseBodyStored",
  "retryableNow",
  "sourceCommitSha",
  "target",
  "vercelAuthRedirect",
]);

export function deploymentStartIdempotencyKey(deploymentId) {
  return `ui06:orchestrate:${deploymentId}`;
}

export function deploymentResumeIdempotencyKey(deploymentId, marker) {
  const attemptId = String(marker || "").split(":").at(-1) || "unknown";
  return `ui06:resume:${deploymentId}:${attemptId}`;
}

export function customerResumeStaleThresholdMs({
  staleAfterMs,
} = {}) {
  if (Number.isFinite(staleAfterMs)) return staleAfterMs;
  return DEFAULT_RESUME_STALE_AFTER_MS;
}

function startMarker(deploymentId) {
  return `${START_MARKER_PREFIX}:${deploymentId}`;
}

function resumeMarker(deploymentId) {
  return `${RESUME_MARKER_PREFIX}:${deploymentId}:${crypto.randomUUID()}`;
}

function isStartMarker(value, deploymentId) {
  return value === startMarker(deploymentId);
}

function safeStage(status) {
  return stageByStatus[status] ?? "Deployment status";
}

function safeTimestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function safeEvidence(metadata = {}) {
  const blocked = /secret|token|credential|authorization|ciphertext|privateKey|providerBody|rawLog|value/i;
  const evidence = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (blocked.test(key) || !safeEvidenceKeys.has(key) || value === undefined) continue;
    evidence[key] = Array.isArray(value) ? value.slice(0, 25) : value;
  }
  return evidence;
}

function isPostgresError(error) {
  return typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code);
}

function redeployDatabaseError(error, stage) {
  if (!isPostgresError(error)) return error;
  const code = stage === "deployment_insert"
    ? "REDEPLOYMENT_INSERT_FAILED"
    : stage === "event_insert"
      ? "REDEPLOYMENT_EVENT_INSERT_FAILED"
      : stage === "commit"
        ? "REDEPLOYMENT_COMMIT_FAILED"
        : "REDEPLOYMENT_START_FAILED";
  return Object.assign(new Error("Redeployment could not be started."), {
    status: 500,
    code,
    redeployStage: stage,
    postgres: {
      sqlstate: error.code,
      constraint: error.constraint ?? null,
      table: error.table ?? null,
      column: error.column ?? null,
    },
    cause: error,
  });
}

function safeEvent(row) {
  const customerType = row.event_type;
  return {
    id: Number(row.id),
    at: safeTimestamp(row.created_at),
    type: customerType,
    title: eventTitles[customerType] ?? "Deployment event recorded",
    fromStatus: row.from_status,
    toStatus: row.to_status,
    evidence: safeEvidence(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
  };
}

function failureDiagnostic(deployment) {
  if (!deployment.error_code && deployment.status !== "FAILED") return null;
  const code = deployment.error_code ?? "DEPLOYMENT_FAILED";
  const diagnostics = {
    ENV_CONFIGURATION_REQUIRED: ["Configuration required", "Review and save required configuration before deploying."],
    BUILD_FAILED: ["Build failed", "Review the deployment build details before redeploying."],
    BUILD_TIMEOUT: ["Build timed out", "The application build exceeded the configured limit."],
    HEALTH_CHECK_FAILED: ["Application did not become healthy", "Review runtime configuration or startup behavior before redeploying."],
    PUBLIC_ACCESS_BLOCKED: ["Public access blocked", "Anonymous HTTPS verification did not pass."],
    DEPLOYMENT_ABANDONED: ["Deployment abandoned", "Start a new deployment when ready."],
  };
  const [title, action] = diagnostics[code] ?? ["Deployment needs attention", "Review deployment progress before retrying."];
  return { code, title, action };
}

export function safeCustomerDeployment(row, events = []) {
  const started = Boolean(row.orchestrator_run_id);
  const active = ACTIVE_STATUSES.has(row.status) && (row.status !== "ANALYZING" || started);
  const terminal = TERMINAL_STATUSES.has(row.status);
  return {
    deploymentId: row.id,
    parentDeploymentId: row.parent_deployment_id ?? null,
    appId: row.app_id,
    status: row.status,
    stage: safeStage(row.status),
    active,
    terminal,
    liveUrl: row.status === "LIVE" ? row.live_url : null,
    sourceCommitSha: row.source_commit_sha,
    sourceBranch: row.source_branch,
    diagnostic: failureDiagnostic(row),
    events,
  };
}

function safeDeployment(row, events = []) {
  return safeCustomerDeployment(row, events);
}

async function loadAuthorizedDeployment(db, { customerId, workspaceId, appId, deploymentId, forUpdate = false }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const result = await db.query(
    `
      SELECT d.id,
             d.workspace_id,
             d.app_id,
             d.status,
             d.error_code,
             d.source_commit_sha,
             d.source_branch,
             d.parent_deployment_id,
             d.orchestrator_run_id,
             d.live_url,
             d.created_at,
             d.updated_at,
             (SELECT max(e.created_at) FROM deployment_events e WHERE e.deployment_id = d.id) AS latest_event_at,
             a.deleted_at AS app_deleted_at,
             bi.id AS build_input_id,
             bi.build_command
        FROM deployments d
        JOIN apps a
          ON a.id = d.app_id
        LEFT JOIN deployment_build_inputs bi
          ON bi.deployment_id = d.id
       WHERE d.workspace_id = $1
         AND d.app_id = $2
         AND d.id = $3
       LIMIT 1
       ${forUpdate ? "FOR UPDATE OF d,a" : ""}
    `,
    [workspaceId, appId, deploymentId],
  );
  const deployment = result.rows[0];
  if (!deployment || deployment.app_deleted_at) {
    throw Object.assign(new Error("Deployment not found."), {
      status: 404,
      code: "DEPLOYMENT_NOT_FOUND",
    });
  }
  return deployment;
}

async function loadRetryChildDeployment(db, { appId, parentDeploymentId }) {
  const result = await db.query(
    `
      SELECT d.id,
             d.workspace_id,
             d.app_id,
             d.status,
             d.error_code,
             d.source_commit_sha,
             d.source_branch,
             d.parent_deployment_id,
             d.orchestrator_run_id,
             d.live_url,
             d.created_at,
             d.updated_at,
             (SELECT max(e.created_at) FROM deployment_events e WHERE e.deployment_id = d.id) AS latest_event_at,
             NULL AS app_deleted_at,
             bi.id AS build_input_id,
             bi.build_command
        FROM deployments d
        LEFT JOIN deployment_build_inputs bi
          ON bi.deployment_id = d.id
       WHERE d.app_id = $1
         AND d.parent_deployment_id = $2
       ORDER BY d.created_at DESC
       LIMIT 2
       FOR UPDATE OF d
    `,
    [appId, parentDeploymentId],
  );
  if (result.rows.length > 1) {
    throw Object.assign(new Error("Retry lineage has multiple direct children."), {
      status: 409,
      code: "DEPLOYMENT_RETRY_LINEAGE_AMBIGUOUS",
    });
  }
  return result.rows[0] ?? null;
}

async function loadRetryLineageDeployment(db, { appId, deploymentId }) {
  const result = await db.query(
    `
      SELECT d.id,
             d.workspace_id,
             d.app_id,
             d.status,
             d.error_code,
             d.source_commit_sha,
             d.source_branch,
             d.parent_deployment_id,
             d.orchestrator_run_id,
             d.live_url,
             d.created_at,
             d.updated_at,
             (SELECT max(e.created_at) FROM deployment_events e WHERE e.deployment_id = d.id) AS latest_event_at,
             NULL AS app_deleted_at,
             bi.id AS build_input_id,
             bi.build_command
        FROM deployments d
        LEFT JOIN deployment_build_inputs bi
          ON bi.deployment_id = d.id
       WHERE d.app_id = $1
         AND d.id = $2
       LIMIT 1
       FOR UPDATE OF d
    `,
    [appId, deploymentId],
  );
  return result.rows[0] ?? null;
}

async function retryLineageRoot(db, { appId, deployment }) {
  const seen = new Set([deployment.id]);
  let current = deployment;

  for (let depth = 0; depth < MAX_RETRY_LINEAGE_TRAVERSAL; depth += 1) {
    if (!current.parent_deployment_id) return current;
    const parent = await loadRetryLineageDeployment(db, { appId, deploymentId: current.parent_deployment_id });
    if (!parent) {
      throw Object.assign(new Error("Retry lineage parent is missing."), {
        status: 409,
        code: "DEPLOYMENT_RETRY_LINEAGE_CORRUPT",
      });
    }
    if (seen.has(parent.id)) {
      throw Object.assign(new Error("Retry lineage is cyclic or corrupted."), {
        status: 409,
        code: "DEPLOYMENT_RETRY_LINEAGE_CORRUPT",
      });
    }
    seen.add(parent.id);
    current = parent;
  }

  throw Object.assign(new Error("Retry lineage exceeds supported traversal depth."), {
    status: 409,
    code: "DEPLOYMENT_RETRY_LINEAGE_TOO_DEEP",
  });
}

async function resolveRetryLineage(db, { appId, deployment }) {
  const root = await retryLineageRoot(db, { appId, deployment });
  const lineage = [root];
  const seen = new Set([root.id]);
  let current = root;

  for (let depth = 0; depth < MAX_RETRY_LINEAGE_TRAVERSAL; depth += 1) {
    const child = await loadRetryChildDeployment(db, { appId, parentDeploymentId: current.id });
    if (!child) {
      return { root, latest: current, lineage, depth: lineage.length - 1 };
    }
    if (seen.has(child.id)) {
      throw Object.assign(new Error("Retry lineage is cyclic or corrupted."), {
        status: 409,
        code: "DEPLOYMENT_RETRY_LINEAGE_CORRUPT",
      });
    }
    seen.add(child.id);
    lineage.push(child);
    current = child;
  }

  throw Object.assign(new Error("Retry lineage exceeds supported traversal depth."), {
    status: 409,
    code: "DEPLOYMENT_RETRY_LINEAGE_TOO_DEEP",
  });
}

async function loadAuthorizedAppForRedeploy(db, { customerId, workspaceId, appId }) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const result = await db.query(
    `
      SELECT a.id,
             a.workspace_id,
             a.deleted_at,
             live.id AS live_deployment_id,
             live.source_commit_sha AS live_source_commit_sha,
             live.source_branch AS live_source_branch
        FROM apps a
        LEFT JOIN LATERAL (
          SELECT id, source_commit_sha, source_branch
            FROM deployments
           WHERE app_id = a.id
             AND status = 'LIVE'
           ORDER BY created_at DESC
           LIMIT 1
        ) live ON true
       WHERE a.workspace_id = $1
         AND a.id = $2
         AND a.deleted_at IS NULL
       LIMIT 1
       FOR UPDATE OF a
    `,
    [workspaceId, appId],
  );
  const app = result.rows[0];
  if (!app) {
    throw Object.assign(new Error("Application not found."), {
      status: 404,
      code: "APP_NOT_FOUND",
    });
  }
  return app;
}

async function loadRedeploymentInProgress(db, { appId }) {
  const result = await db.query(
    `
      SELECT d.id,
             d.workspace_id,
             d.app_id,
             d.status,
             d.error_code,
             d.source_commit_sha,
             d.source_branch,
             d.parent_deployment_id,
             d.orchestrator_run_id,
             d.live_url,
             d.created_at,
             d.updated_at,
             (SELECT max(e.created_at) FROM deployment_events e WHERE e.deployment_id = d.id) AS latest_event_at,
             NULL AS app_deleted_at,
             bi.id AS build_input_id,
             bi.build_command
        FROM deployments d
        LEFT JOIN deployment_build_inputs bi
          ON bi.deployment_id = d.id
       WHERE d.app_id = $1
         AND d.status = ANY($2::deployment_status[])
       ORDER BY d.created_at DESC
       LIMIT 1
       FOR UPDATE OF d
    `,
    [appId, REDEPLOY_IN_PROGRESS_STATUSES],
  );
  return result.rows[0] ?? null;
}

function timestampMs(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function latestProgressMs(deployment) {
  return Math.max(
    timestampMs(deployment.updated_at),
    timestampMs(deployment.latest_event_at),
    timestampMs(deployment.created_at),
  );
}

function resumeEligibility(deployment, { now = Date.now(), staleAfterMs = DEFAULT_RESUME_STALE_AFTER_MS } = {}) {
  if (!RESUMABLE_STATUSES.has(deployment.status)) return { eligible: false, reason: "not-resumable-status" };
  if (deployment.error_code) return { eligible: false, reason: "deployment-has-error" };
  if (!deployment.source_commit_sha) return { eligible: false, reason: "source-identity-missing" };
  const lastProgressMs = latestProgressMs(deployment);
  const ageMs = Math.max(0, now - lastProgressMs);
  if (ageMs < staleAfterMs) return { eligible: false, reason: "recent-progress", ageMs };
  return { eligible: true, reason: "stale-recoverable", ageMs };
}

async function recordDeploymentEvent(db, { deploymentId, fromStatus, toStatus, eventType, message, metadata = {} }) {
  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [deploymentId, fromStatus, toStatus, eventType, message, JSON.stringify(metadata)],
  );
}

async function assertLatestDeployment(db, { appId, deploymentId }) {
  const latest = await db.query(
    `SELECT id
       FROM deployments
      WHERE app_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [appId],
  );
  if (latest.rows[0]?.id !== deploymentId) {
    throw Object.assign(new Error("Deployment is not the latest analysed deployment."), {
      status: 409,
      code: "DEPLOYMENT_NOT_CURRENT",
    });
  }
}

async function loadDeploymentEvents(db, deploymentId, limit = 25) {
  const result = await db.query(
    `SELECT id, event_type, from_status, to_status, metadata, created_at
       FROM deployment_events
      WHERE deployment_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [deploymentId, limit],
  );
  return result.rows.reverse().map(safeEvent);
}

function triggerBaseUrl(env) {
  return (env.TRIGGER_API_URL || "https://api.trigger.dev").replace(/\/$/, "");
}

export async function triggerDeploymentOrchestrator({
  deploymentId,
  idempotencyKey = deploymentStartIdempotencyKey(deploymentId),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const secret = env.TRIGGER_SECRET_KEY;
  if (!secret) {
    throw Object.assign(new Error("TRIGGER_SECRET_KEY is required for deployment orchestration."), {
      status: 500,
      code: "TRIGGER_SECRET_KEY_REQUIRED",
    });
  }
  const response = await fetchImpl(
    `${triggerBaseUrl(env)}/api/v1/tasks/${encodeURIComponent(ORCHESTRATOR_TASK_ID)}/trigger`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "x-trigger-api-version": "2025-07-16",
        "x-trigger-source": "utplava-customer-interface",
      },
      body: JSON.stringify({
        payload: { deploymentId },
        options: {
          payloadType: "application/json",
          idempotencyKey,
          tags: [`deployment:${deploymentId}`, "ui06"],
        },
      }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error("Deployment orchestration could not be started."), {
      status: 502,
      code: "TRIGGER_ORCHESTRATION_START_FAILED",
    });
  }
  if (typeof body?.id !== "string" || !body.id) {
    throw Object.assign(new Error("Deployment orchestration returned no run id."), {
      status: 502,
      code: "TRIGGER_RUN_ID_MISSING",
    });
  }
  return { id: body.id };
}

export async function getCustomerDeploymentProgress(db, { customerId, workspaceId, appId, deploymentId }) {
  const deployment = await loadAuthorizedDeployment(db, { customerId, workspaceId, appId, deploymentId });
  const events = await loadDeploymentEvents(db, deploymentId);
  return safeDeployment(deployment, events);
}

export async function resumeCustomerDeployment(
  db,
  {
    customerId,
    workspaceId,
    appId,
    deploymentId,
    triggerOrchestrator = triggerDeploymentOrchestrator,
    staleAfterMs,
    now = Date.now(),
    env = process.env,
  },
) {
  const effectiveStaleAfterMs = customerResumeStaleThresholdMs({
    env,
    deploymentId,
    workspaceId,
    appId,
    staleAfterMs,
  });
  let shouldTrigger = false;
  let marker = null;
  let resumeStatus = null;
  let outcome = { attempted: false, started: false, suppressed: false, reason: null };

  await db.query("BEGIN");
  try {
    const deployment = await loadAuthorizedDeployment(db, {
      customerId,
      workspaceId,
      appId,
      deploymentId,
      forUpdate: true,
    });
    await assertLatestDeployment(db, { appId, deploymentId });

    const eligibility = resumeEligibility(deployment, { now, staleAfterMs: effectiveStaleAfterMs });
    if (!eligibility.eligible) {
      outcome = { attempted: false, started: false, suppressed: true, reason: eligibility.reason };
    } else {
      marker = resumeMarker(deploymentId);
      const claimed = await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND status = $3
            AND error_code IS NULL
          RETURNING id`,
        [marker, deploymentId, deployment.status],
      );
      if (claimed.rowCount === 1) {
        resumeStatus = deployment.status;
        await recordDeploymentEvent(db, {
          deploymentId,
          fromStatus: deployment.status,
          toStatus: deployment.status,
          eventType: "DEPLOYMENT_RESUME_REQUESTED",
          message: "Recoverable deployment orchestration resume requested",
          metadata: {
            reason: eligibility.reason,
            ageMs: eligibility.ageMs,
            resumeMarker: marker,
            responseBodyStored: false,
          },
        });
        shouldTrigger = true;
        outcome = { attempted: true, started: false, suppressed: false, reason: eligibility.reason };
      } else {
        outcome = { attempted: false, started: false, suppressed: true, reason: "resume-claim-lost" };
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }

  if (shouldTrigger) {
    try {
      const handle = await triggerOrchestrator({
        deploymentId,
        idempotencyKey: deploymentResumeIdempotencyKey(deploymentId, marker),
      });
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND orchestrator_run_id = $3`,
        [handle.id, deploymentId, marker],
      );
      await recordDeploymentEvent(db, {
        deploymentId,
        fromStatus: resumeStatus,
        toStatus: resumeStatus,
        eventType: "DEPLOYMENT_RESUME_STARTED",
        message: "Recoverable deployment orchestration resume started",
        metadata: {
          responseBodyStored: false,
        },
      });
      outcome = { ...outcome, started: true };
    } catch (error) {
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = NULL,
                updated_at = now()
          WHERE id = $1
            AND orchestrator_run_id = $2`,
        [deploymentId, marker],
      ).catch(() => {});
      await recordDeploymentEvent(db, {
        deploymentId,
        fromStatus: resumeStatus,
        toStatus: resumeStatus,
        eventType: "DEPLOYMENT_RESUME_FAILED",
        message: "Recoverable deployment orchestration resume could not be started",
        metadata: {
          responseBodyStored: false,
        },
      }).catch(() => {});
      throw error;
    }
  }

  const deployment = await getCustomerDeploymentProgress(db, { customerId, workspaceId, appId, deploymentId });
  return {
    ...deployment,
    resume: outcome,
  };
}

export async function getCustomerDeploymentProgressWithResume(
  db,
  {
    customerId,
    workspaceId,
    appId,
    deploymentId,
    triggerOrchestrator = triggerDeploymentOrchestrator,
    staleAfterMs,
    now = Date.now(),
    env = process.env,
  },
) {
  const effectiveStaleAfterMs = customerResumeStaleThresholdMs({
    env,
    deploymentId,
    workspaceId,
    appId,
    staleAfterMs,
  });
  const current = await loadAuthorizedDeployment(db, { customerId, workspaceId, appId, deploymentId });
  const eligibility = resumeEligibility(current, { now, staleAfterMs: effectiveStaleAfterMs });
  if (eligibility.eligible) {
    return resumeCustomerDeployment(db, {
      customerId,
      workspaceId,
      appId,
      deploymentId,
      triggerOrchestrator,
      staleAfterMs: effectiveStaleAfterMs,
      now,
      env,
    });
  }
  const events = await loadDeploymentEvents(db, deploymentId);
  return {
    ...safeDeployment(current, events),
    resume: { attempted: false, started: false, suppressed: !eligibility.eligible, reason: eligibility.reason },
  };
}

export async function startCustomerDeployment(
  db,
  {
    customerId,
    workspaceId,
    appId,
    deploymentId,
    triggerOrchestrator = triggerDeploymentOrchestrator,
  },
) {
  const readiness = await getDeploymentReadiness(db, { customerId, workspaceId, appId });
  if (readiness.deploymentId !== deploymentId) {
    throw Object.assign(new Error("Deployment is not the current deployment for this app."), {
      status: 409,
      code: "DEPLOYMENT_NOT_CURRENT",
    });
  }

  const marker = startMarker(deploymentId);
  let shouldTrigger = false;
  let alreadyStarted = false;

  await db.query("BEGIN");
  try {
    const deployment = await loadAuthorizedDeployment(db, {
      customerId,
      workspaceId,
      appId,
      deploymentId,
      forUpdate: true,
    });
    await assertLatestDeployment(db, { appId, deploymentId });

    if (!deployment.build_input_id || !deployment.build_command) {
      throw Object.assign(new Error("Deployment analysis is incomplete."), {
        status: 409,
        code: "ANALYSIS_REQUIRED",
      });
    }
    if (deployment.status === "LIVE") {
      alreadyStarted = true;
    } else if (ACTIVE_STATUSES.has(deployment.status) && deployment.status !== "ANALYZING") {
      alreadyStarted = true;
    } else if (deployment.status !== "ANALYZING") {
      throw Object.assign(new Error("Deployment is not eligible to start."), {
        status: 409,
        code: "DEPLOYMENT_NOT_ELIGIBLE",
      });
    } else if (deployment.orchestrator_run_id && !isStartMarker(deployment.orchestrator_run_id, deploymentId)) {
      alreadyStarted = true;
    } else if (readiness.readiness !== "READY_TO_DEPLOY" || deployment.error_code) {
      throw Object.assign(new Error("Deployment is not ready."), {
        status: 409,
        code: readiness.blockingCode || deployment.error_code || "DEPLOYMENT_NOT_READY",
      });
    } else {
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND (orchestrator_run_id IS NULL OR orchestrator_run_id = $1)`,
        [marker, deploymentId],
      );
      shouldTrigger = true;
    }

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }

  let triggerRunId = null;
  if (shouldTrigger) {
    try {
      const handle = await triggerOrchestrator({
        deploymentId,
        idempotencyKey: deploymentStartIdempotencyKey(deploymentId),
      });
      triggerRunId = handle.id;
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND (orchestrator_run_id IS NULL OR orchestrator_run_id = $3 OR orchestrator_run_id = $1)`,
        [triggerRunId, deploymentId, marker],
      );
    } catch (error) {
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = NULL,
                updated_at = now()
          WHERE id = $1
            AND orchestrator_run_id = $2`,
        [deploymentId, marker],
      ).catch(() => {});
      throw error;
    }
  }

  const deployment = await getCustomerDeploymentProgress(db, { customerId, workspaceId, appId, deploymentId });
  return {
    ...deployment,
    start: {
      started: shouldTrigger,
      alreadyStarted,
    },
  };
}

export async function retryFailedCustomerDeployment(
  db,
  {
    customerId,
    workspaceId,
    appId,
    deploymentId,
    triggerOrchestrator = triggerDeploymentOrchestrator,
    deploymentKeyFactory = () => `dep_${crypto.randomUUID().replaceAll("-", "")}`,
  },
) {
  let childDeploymentId = null;
  let shouldTrigger = false;
  let alreadyStarted = false;
  let created = false;
  let parentForResponse = deploymentId;
  let retryDepth = 0;
  let retryLimitReached = false;

  await db.query("BEGIN");
  try {
    // Same automatic containment as redeployLiveCustomerApp: a repeatedly
    // failing app gets paused rather than letting retries continue
    // unbounded. Checked first, inside the transaction, so a pause decided
    // by this exact call is committed atomically with everything else.
    await enforceFailureCooldown(db, { appId });

    const requested = await loadAuthorizedDeployment(db, {
      customerId,
      workspaceId,
      appId,
      deploymentId,
      forUpdate: true,
    });
    if (requested.status !== "FAILED") {
      throw Object.assign(new Error("Only failed deployments can be retried."), {
        status: 409,
        code: "DEPLOYMENT_RETRY_NOT_ELIGIBLE",
      });
    }
    if (!requested.source_commit_sha) {
      throw Object.assign(new Error("Failed deployment has no immutable source commit."), {
        status: 409,
        code: "DEPLOYMENT_SOURCE_MISSING",
      });
    }

    const lineage = await resolveRetryLineage(db, { appId, deployment: requested });
    let child = lineage.latest;
    retryDepth = lineage.depth;
    parentForResponse = child.parent_deployment_id ?? requested.id;

    if (child.status === "FAILED" && retryDepth >= MAX_CUSTOMER_RETRY_DEPTH) {
      await assertLatestDeployment(db, { appId, deploymentId: child.id });
      childDeploymentId = child.id;
      retryLimitReached = true;
    } else if (child.status === "FAILED") {
      if (!child.source_commit_sha) {
        throw Object.assign(new Error("Failed deployment has no immutable source commit."), {
          status: 409,
          code: "DEPLOYMENT_SOURCE_MISSING",
        });
      }
      await assertLatestDeployment(db, { appId, deploymentId: child.id });
      const retryParent = child;
      const createdChild = await db.query(
        `INSERT INTO deployments
           (deployment_key, workspace_id, app_id, source_commit_sha, source_branch,
            status, parent_deployment_id, deployment_reason)
         VALUES ($1,$2,$3,$4,$5,'ANALYZING',$6,'redeploy')
         RETURNING id,
                   workspace_id,
                   app_id,
                   status,
                   error_code,
                   source_commit_sha,
                   source_branch,
                   parent_deployment_id,
                   orchestrator_run_id,
                   live_url,
                   created_at`,
        [
          deploymentKeyFactory(),
          child.workspace_id,
          child.app_id,
          child.source_commit_sha,
          child.source_branch,
          child.id,
        ],
      );
      child = {
        ...createdChild.rows[0],
        app_deleted_at: null,
        build_input_id: null,
        build_command: null,
      };
      await db.query(
        `INSERT INTO deployment_events
           (deployment_id, from_status, to_status, event_type, message, metadata)
         VALUES ($1,'DRAFT','ANALYZING','REDEPLOY_CREATED',$2,$3::jsonb)`,
        [
          child.id,
          "Retry deployment created from failed immutable source",
          JSON.stringify({
            retryDepth: retryDepth + 1,
            retryRootDeploymentId: lineage.root.id,
            parentDeploymentId: retryParent.id,
            sourceCommitSha: retryParent.source_commit_sha,
            sourceBranch: retryParent.source_branch,
          }),
        ],
      );
      created = true;
      retryDepth += 1;
      parentForResponse = child.parent_deployment_id;
    }

    childDeploymentId = child.id;
    if (retryLimitReached) {
      alreadyStarted = false;
    } else if (child.status === "LIVE") {
      alreadyStarted = true;
    } else if (ACTIVE_STATUSES.has(child.status) && child.status !== "ANALYZING") {
      alreadyStarted = true;
    } else if (child.status !== "ANALYZING") {
      throw Object.assign(new Error("Retry deployment is not eligible to start."), {
        status: 409,
        code: "DEPLOYMENT_RETRY_NOT_ELIGIBLE",
      });
    } else if (child.orchestrator_run_id && !isStartMarker(child.orchestrator_run_id, child.id)) {
      alreadyStarted = true;
    } else {
      const marker = startMarker(child.id);
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND (orchestrator_run_id IS NULL OR orchestrator_run_id = $1)`,
        [marker, child.id],
      );
      shouldTrigger = true;
    }

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }

  let triggerRunId = null;
  if (shouldTrigger) {
    const marker = startMarker(childDeploymentId);
    try {
      const handle = await triggerOrchestrator({
        deploymentId: childDeploymentId,
        idempotencyKey: deploymentStartIdempotencyKey(childDeploymentId),
      });
      triggerRunId = handle.id;
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND (orchestrator_run_id IS NULL OR orchestrator_run_id = $3 OR orchestrator_run_id = $1)`,
        [triggerRunId, childDeploymentId, marker],
      );
    } catch (error) {
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = NULL,
                updated_at = now()
          WHERE id = $1
            AND orchestrator_run_id = $2`,
        [childDeploymentId, marker],
      ).catch(() => {});
      throw error;
    }
  }

  const deployment = await getCustomerDeploymentProgress(db, {
    customerId,
    workspaceId,
    appId,
    deploymentId: childDeploymentId,
  });
  return {
    ...deployment,
    retry: {
      parentDeploymentId: parentForResponse,
      requestedDeploymentId: deploymentId,
      retryDepth,
      maxRetryDepth: MAX_CUSTOMER_RETRY_DEPTH,
      limitReached: retryLimitReached,
      code: retryLimitReached ? "DEPLOYMENT_RETRY_LIMIT_REACHED" : null,
      created,
      started: shouldTrigger,
      alreadyStarted,
    },
  };
}

export async function redeployLiveCustomerApp(
  db,
  {
    customerId,
    workspaceId,
    appId,
    triggerOrchestrator = triggerDeploymentOrchestrator,
    deploymentKeyFactory = () => `dep_${crypto.randomUUID().replaceAll("-", "")}`,
  },
) {
  let deploymentId = null;
  let parentDeploymentId = null;
  let shouldTrigger = false;
  let alreadyStarted = false;
  let created = false;
  let reusedActive = false;
  let operationStage = "before_insert";

  // Bounds how fast redeploys can be requested — the concrete risk this
  // protects against is a stuck or fast-looping caller (today a human
  // double-clicking, tomorrow the intended MCP `deploy`/`redeploy` tool)
  // generating far more build/provider load than a person realistically
  // would. This does not replace the per-app "already in progress" guard
  // below; it bounds the *rate of requests*, not just concurrent state.
  await enforceRateLimit(db, {
    workspaceId,
    action: "redeploy",
    limit: 20,
    windowSeconds: 3600,
  });

  await db.query("BEGIN");
  try {
    // Automatic, no-founder-in-the-loop containment: if this app has already
    // failed repeatedly in a short window, stop here with a clear reason
    // instead of letting another attempt burn more build minutes on what is
    // very likely the same underlying problem. Sticky — stays paused until a
    // separate, explicit resume action, unlike the rate limit above which
    // just resets on the next window. Inside the transaction so a pause
    // decided by this call commits atomically with everything else.
    await enforceFailureCooldown(db, { appId });

    const app = await loadAuthorizedAppForRedeploy(db, { customerId, workspaceId, appId });
    if (!app.live_deployment_id || !app.live_source_commit_sha) {
      throw Object.assign(new Error("Redeploy requires an existing live deployment."), {
        status: 409,
        code: "LIVE_DEPLOYMENT_REQUIRED",
      });
    }
    parentDeploymentId = app.live_deployment_id;

    let deployment = await loadRedeploymentInProgress(db, { appId });
    if (deployment) {
      reusedActive = true;
    } else {
      operationStage = "deployment_insert";
      const createdDeployment = await db.query(
        `INSERT INTO deployments
           (deployment_key, workspace_id, app_id, source_commit_sha, source_branch,
            status, parent_deployment_id, deployment_reason)
         VALUES ($1,$2,$3,$4,$5,'ANALYZING',$6,'redeploy')
         RETURNING id,
                   workspace_id,
                   app_id,
                   status,
                   error_code,
                   source_commit_sha,
                   source_branch,
                   parent_deployment_id,
                   orchestrator_run_id,
                   live_url,
                   created_at`,
        [
          deploymentKeyFactory(),
          app.workspace_id,
          app.id,
          app.live_source_commit_sha,
          app.live_source_branch,
          app.live_deployment_id,
        ],
      );
      deployment = {
        ...createdDeployment.rows[0],
        app_deleted_at: null,
        build_input_id: null,
        build_command: null,
      };
      operationStage = "event_insert";
      await db.query(
        `INSERT INTO deployment_events
           (deployment_id, from_status, to_status, event_type, message, metadata)
         VALUES ($1,'READY','ANALYZING','REDEPLOY_CREATED',$2,$3::jsonb)`,
        [
          deployment.id,
          "Redeployment created from current immutable source",
          JSON.stringify({
            parentDeploymentId: app.live_deployment_id,
            sourceCommitSha: app.live_source_commit_sha,
            sourceBranch: app.live_source_branch,
          }),
        ],
      );
      created = true;
    }

    operationStage = "before_insert";
    deploymentId = deployment.id;
    if (deployment.status === "FAILED") {
      throw Object.assign(new Error("The existing redeployment has already failed."), {
        status: 409,
        code: "REDEPLOYMENT_ALREADY_FAILED",
      });
    }
    if (deployment.status === "LIVE") {
      alreadyStarted = true;
    } else if (ACTIVE_STATUSES.has(deployment.status) && deployment.status !== "ANALYZING") {
      alreadyStarted = true;
    } else if (deployment.status !== "ANALYZING") {
      throw Object.assign(new Error("Redeployment is not eligible to start."), {
        status: 409,
        code: "REDEPLOYMENT_NOT_ELIGIBLE",
      });
    } else if (deployment.orchestrator_run_id && !isStartMarker(deployment.orchestrator_run_id, deployment.id)) {
      alreadyStarted = true;
    } else {
      const marker = startMarker(deployment.id);
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND (orchestrator_run_id IS NULL OR orchestrator_run_id = $1)`,
        [marker, deployment.id],
      );
      shouldTrigger = true;
    }

    operationStage = "commit";
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    if (!error.redeployStage) error.redeployStage = operationStage;
    throw redeployDatabaseError(error, operationStage);
  }

  let triggerRunId = null;
  if (shouldTrigger) {
    const marker = startMarker(deploymentId);
    try {
      const handle = await triggerOrchestrator({
        deploymentId,
        idempotencyKey: deploymentStartIdempotencyKey(deploymentId),
      });
      triggerRunId = handle.id;
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = $1,
                updated_at = now()
          WHERE id = $2
            AND (orchestrator_run_id IS NULL OR orchestrator_run_id = $3 OR orchestrator_run_id = $1)`,
        [triggerRunId, deploymentId, marker],
      );
    } catch (error) {
      await db.query(
        `UPDATE deployments
            SET orchestrator_run_id = NULL,
                updated_at = now()
          WHERE id = $1
            AND orchestrator_run_id = $2`,
        [deploymentId, marker],
      ).catch(() => {});
      throw error;
    }
  }

  const deployment = await getCustomerDeploymentProgress(db, {
    customerId,
    workspaceId,
    appId,
    deploymentId,
  });
  return {
    ...deployment,
    redeploy: {
      parentDeploymentId,
      created,
      started: shouldTrigger,
      alreadyStarted,
      reusedActive,
    },
  };
}
