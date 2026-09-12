import pg from "pg";

const { Client } = pg;

export const INTERNAL_RESUME_ACCEPTANCE_EVENT = "INTERNAL_RESUME_ACCEPTANCE_INTERRUPTED";
export const INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV = "AFTER_ENV_VERIFIED";

function enabled(value) {
  return String(value || "").toLowerCase() === "true";
}

export function internalResumeAcceptanceHookEnabled({
  env = process.env,
  deploymentId,
  point = INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
} = {}) {
  return enabled(env.UTPLAVA_INTERNAL_RESUME_TEST_MODE)
    && env.UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID === deploymentId
    && (env.UTPLAVA_INTERNAL_RESUME_TEST_POINT || INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV) === point;
}

async function defaultConnectDatabase(env) {
  if (!env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  return db;
}

export async function recordInternalResumeAcceptanceInterruption(db, { deploymentId, status, point }) {
  if (status !== "ANALYZING") {
    return { interrupted: false, reason: "not-safe-state", status, point };
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
        responseBodyStored: false,
      }),
    ],
  );

  return { interrupted: true, reason: "internal-alpha-acceptance", status, point };
}

export async function maybeInterruptInternalResumeAcceptance({
  deploymentId,
  status,
  point = INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  env = process.env,
  connectDatabase = defaultConnectDatabase,
} = {}) {
  if (!internalResumeAcceptanceHookEnabled({ env, deploymentId, point })) {
    return { interrupted: false, reason: "disabled", status, point };
  }

  const db = await connectDatabase(env);
  try {
    return await recordInternalResumeAcceptanceInterruption(db, { deploymentId, status, point });
  } finally {
    await db.end?.();
  }
}
