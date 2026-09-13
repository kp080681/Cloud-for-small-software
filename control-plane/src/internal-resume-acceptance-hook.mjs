import pg from "pg";

const { Client } = pg;

export const INTERNAL_RESUME_ACCEPTANCE_EVENT = "INTERNAL_RESUME_ACCEPTANCE_INTERRUPTED";
export const INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV = "AFTER_ENV_VERIFIED";

function enabled(value) {
  return String(value || "").toLowerCase() === "true";
}

function generationValue(env) {
  const value = String(env.UTPLAVA_INTERNAL_RESUME_TEST_GENERATION || "").trim();
  return value || null;
}

export function internalResumeAcceptanceHookEnabled({
  env = process.env,
  deploymentId,
  workspaceId,
  appId,
  point = INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
} = {}) {
  return internalResumeAcceptanceSelector({ env, deploymentId, workspaceId, appId, point }).enabled;
}

export function internalResumeAcceptanceSelector({
  env = process.env,
  deploymentId,
  workspaceId,
  appId,
  point = INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
} = {}) {
  if (!enabled(env.UTPLAVA_INTERNAL_RESUME_TEST_MODE)) {
    return { enabled: false, reason: "mode-disabled" };
  }
  if ((env.UTPLAVA_INTERNAL_RESUME_TEST_POINT || INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV) !== point) {
    return { enabled: false, reason: "point-mismatch" };
  }
  if (env.UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID) {
    return env.UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID === deploymentId
      ? { enabled: true, selectorType: "deployment", deploymentId, point }
      : { enabled: false, reason: "deployment-mismatch" };
  }
  if (!enabled(env.UTPLAVA_INTERNAL_RESUME_TEST_ONCE)) {
    return { enabled: false, reason: "app-selector-not-once" };
  }
  if (!env.UTPLAVA_INTERNAL_RESUME_TEST_WORKSPACE_ID || !env.UTPLAVA_INTERNAL_RESUME_TEST_APP_ID) {
    return { enabled: false, reason: "app-selector-incomplete" };
  }
  if (
    env.UTPLAVA_INTERNAL_RESUME_TEST_WORKSPACE_ID !== workspaceId
    || env.UTPLAVA_INTERNAL_RESUME_TEST_APP_ID !== appId
  ) {
    return { enabled: false, reason: "app-selector-mismatch" };
  }
  const generation = generationValue(env);
  return {
    enabled: true,
    selectorType: "app-once",
    workspaceId,
    appId,
    point,
    ...(generation ? { generation } : {}),
  };
}

async function defaultConnectDatabase(env) {
  if (!env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  return db;
}

export async function recordInternalResumeAcceptanceInterruption(
  db,
  {
    deploymentId,
    workspaceId = null,
    appId = null,
    status,
    point,
    selector = { selectorType: "deployment" },
  },
) {
  if (status !== "ANALYZING") {
    return { interrupted: false, reason: "not-safe-state", status, point };
  }

  if (selector.selectorType === "app-once") {
    const generation = selector.generation ?? null;
    const consumed = await db.query(
      `SELECT e.id
         FROM deployment_events e
         JOIN deployments d
           ON d.id = e.deployment_id
        WHERE d.workspace_id = $1
          AND d.app_id = $2
          AND e.event_type = $3
          ${generation ? "AND e.metadata->>'generation' = $4" : ""}
        LIMIT 1`,
      generation
        ? [workspaceId, appId, INTERNAL_RESUME_ACCEPTANCE_EVENT, generation]
        : [workspaceId, appId, INTERNAL_RESUME_ACCEPTANCE_EVENT],
    );
    if (consumed.rowCount > 0) {
      return { interrupted: false, reason: "selector-already-consumed", status, point };
    }
  }

  const existing = await db.query(
    `SELECT id
       FROM deployment_events
      WHERE deployment_id = $1
        AND event_type = $2
      LIMIT 1`,
    [deploymentId, INTERNAL_RESUME_ACCEPTANCE_EVENT],
  );
  if (existing.rowCount > 0) {
    return { interrupted: false, reason: "already-interrupted", status, point };
  }

  await db.query(
    `INSERT INTO deployment_events
       (deployment_id, from_status, to_status, event_type, message, metadata)
     VALUES ($1, 'ANALYZING', 'ANALYZING', $2, $3, $4::jsonb)`,
    [
      deploymentId,
      INTERNAL_RESUME_ACCEPTANCE_EVENT,
      "Internal alpha auto-resume acceptance interruption recorded",
      JSON.stringify({
        point,
        status,
        selectorType: selector.selectorType ?? "deployment",
        workspaceId: selector.selectorType === "app-once" ? workspaceId : undefined,
        appId: selector.selectorType === "app-once" ? appId : undefined,
        generation: selector.selectorType === "app-once" ? selector.generation : undefined,
        responseBodyStored: false,
      }),
    ],
  );

  return { interrupted: true, reason: "internal-alpha-acceptance", status, point };
}

export async function maybeInterruptInternalResumeAcceptance({
  deploymentId,
  workspaceId,
  appId,
  status,
  point = INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  env = process.env,
  connectDatabase = defaultConnectDatabase,
} = {}) {
  const selector = internalResumeAcceptanceSelector({ env, deploymentId, workspaceId, appId, point });
  if (!selector.enabled) {
    return { interrupted: false, reason: selector.reason ?? "disabled", status, point };
  }

  const db = await connectDatabase(env);
  try {
    return await recordInternalResumeAcceptanceInterruption(db, {
      deploymentId,
      workspaceId,
      appId,
      status,
      point,
      selector,
    });
  } finally {
    await db.end?.();
  }
}
