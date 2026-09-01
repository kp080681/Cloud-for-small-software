import pg from "pg";

const EXPECTED_APP_ID = "6bc015df-ccb1-4151-982e-3ea24e45c54b";
const EXPECTED_APP_SLUG = "ssc-recovery-test";
const EXPECTED_DEPLOYMENT_ID = "06581b97-14f7-43f4-8254-947d2235efb9";
const EXPECTED_PROVIDER_DEPLOYMENT_ID = "dpl_231x5RiipsGgzEqaVG7NmdnD47Sm";
const EXPECTED_MAX_ATTEMPTS = 3;

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const result = await db.query(
    `SELECT d.id,d.app_id,d.status,d.provider_deployment_id,a.slug,
            b.provider_deployment_id AS build_provider_deployment_id,
            b.provider_deployment_url,
            COALESCE(p.max_health_attempts,3)::int AS max_health_attempts
       FROM deployments d
       JOIN apps a ON a.id=d.app_id
       JOIN deployment_builds b ON b.deployment_id=d.id
       LEFT JOIN app_resource_policies p ON p.app_id=d.app_id
      WHERE d.id=$1`,
    [EXPECTED_DEPLOYMENT_ID],
  );

  if (result.rowCount !== 1) throw new Error("Guard refused: expected disposable deployment was not found exactly once");
  const row = result.rows[0];
  const guards = [
    [row.app_id === EXPECTED_APP_ID, "app id"],
    [row.slug === EXPECTED_APP_SLUG, "app slug"],
    [row.status === "LIVE", "deployment status LIVE"],
    [row.provider_deployment_id === EXPECTED_PROVIDER_DEPLOYMENT_ID, "deployment provider id"],
    [row.build_provider_deployment_id === EXPECTED_PROVIDER_DEPLOYMENT_ID, "build provider id"],
    [Boolean(row.provider_deployment_url), "provider deployment URL"],
    [Number(row.max_health_attempts) === EXPECTED_MAX_ATTEMPTS, "max health attempts = 3"],
  ];
  const failed = guards.filter(([ok]) => !ok).map(([,name]) => name);
  if (failed.length) throw new Error(`Guard refused: ${failed.join(", ")}`);

  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM deployment_health_checks WHERE deployment_id=$1`, [EXPECTED_DEPLOYMENT_ID]);
    for (let attempt = 1; attempt <= EXPECTED_MAX_ATTEMPTS; attempt += 1) {
      await db.query(
        `INSERT INTO deployment_health_checks
           (deployment_id,check_url,attempt_number,status,http_status,latency_ms,error_code)
         VALUES ($1,$2,$3,'UNHEALTHY',503,1,'NODE_04_18_INJECTED_UNHEALTHY')`,
        [EXPECTED_DEPLOYMENT_ID, row.provider_deployment_url, attempt],
      );
    }
    const changed = await db.query(
      `UPDATE deployments
          SET status='HEALTH_CHECKING',live_url=NULL,error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=now()
        WHERE id=$1 AND app_id=$2 AND status='LIVE' AND provider_deployment_id=$3
        RETURNING id`,
      [EXPECTED_DEPLOYMENT_ID, EXPECTED_APP_ID, EXPECTED_PROVIDER_DEPLOYMENT_ID],
    );
    if (changed.rowCount !== 1) throw new Error("Guard refused during transaction: deployment state changed unexpectedly");
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }

  const verify = await db.query(
    `SELECT d.status,count(h.id)::int AS health_attempt_count
       FROM deployments d
       LEFT JOIN deployment_health_checks h ON h.deployment_id=d.id
      WHERE d.id=$1 GROUP BY d.id,d.status`,
    [EXPECTED_DEPLOYMENT_ID],
  );
  const after = verify.rows[0];
  if (after.status !== "HEALTH_CHECKING" || Number(after.health_attempt_count) !== EXPECTED_MAX_ATTEMPTS) {
    throw new Error("Fault injection verification failed");
  }

  console.log(JSON.stringify({
    result: "NODE_04_18_FAULT_INJECTED_HEALTH_EXHAUSTION",
    appId: EXPECTED_APP_ID,
    appSlug: EXPECTED_APP_SLUG,
    deploymentId: EXPECTED_DEPLOYMENT_ID,
    status: after.status,
    injectedUnhealthyAttempts: Number(after.health_attempt_count),
    maxHealthAttempts: EXPECTED_MAX_ATTEMPTS,
    providerDeploymentId: EXPECTED_PROVIDER_DEPLOYMENT_ID,
    externalProviderDeploymentModified: false,
  }, null, 2));
} finally {
  await db.end();
}
