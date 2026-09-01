import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const expectedAppId = "6bc015df-ccb1-4151-982e-3ea24e45c54b";
const expectedDeploymentId = "06581b97-14f7-43f4-8254-947d2235efb9";
const expectedAppSlug = "ssc-recovery-test";
const expectedProviderDeploymentId = "dpl_231x5RiipsGgzEqaVG7NmdnD47Sm";

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const result = await db.query(
    `SELECT d.id AS deployment_id,
            d.app_id,
            d.status,
            d.provider_deployment_id,
            a.slug AS app_slug,
            b.provider_deployment_id AS build_provider_deployment_id,
            o.status AS operation_status,
            o.provider_resource_id
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN deployment_builds b ON b.deployment_id = d.id
       LEFT JOIN deployment_provider_operations o
         ON o.deployment_id = d.id
        AND o.operation_type = 'vercel-create-deployment'
      WHERE d.id = $1`,
    [expectedDeploymentId],
  );

  if (result.rowCount !== 1) throw new Error("Disposable deployment not found; refusing fault injection");
  const row = result.rows[0];

  const guards = [
    [row.app_id === expectedAppId, `app id mismatch: ${row.app_id}`],
    [row.app_slug === expectedAppSlug, `app slug mismatch: ${row.app_slug}`],
    [row.status === "BUILDING", `deployment must be BUILDING; current status is ${row.status}`],
    [row.provider_deployment_id === expectedProviderDeploymentId, `deployment provider id mismatch: ${row.provider_deployment_id}`],
    [row.build_provider_deployment_id === expectedProviderDeploymentId, `build provider id mismatch: ${row.build_provider_deployment_id}`],
    [row.provider_resource_id === expectedProviderDeploymentId, `operation provider id mismatch: ${row.provider_resource_id}`],
    [row.operation_status === "OBSERVED", `provider operation must be OBSERVED; current status is ${row.operation_status}`],
  ];

  const failed = guards.find(([ok]) => !ok);
  if (failed) throw new Error(`Safety guard failed: ${failed[1]}. Refusing fault injection.`);

  await db.query("BEGIN");
  try {
    const deleted = await db.query(
      `DELETE FROM deployment_builds
        WHERE deployment_id = $1
          AND provider_deployment_id = $2
      RETURNING provider_deployment_id`,
      [expectedDeploymentId, expectedProviderDeploymentId],
    );
    if (deleted.rowCount !== 1) throw new Error("Expected exactly one disposable build attachment to be deleted");

    const cleared = await db.query(
      `UPDATE deployments
          SET provider_deployment_id = NULL,
              updated_at = now()
        WHERE id = $1
          AND app_id = $2
          AND status = 'BUILDING'
          AND provider_deployment_id = $3
      RETURNING id`,
      [expectedDeploymentId, expectedAppId, expectedProviderDeploymentId],
    );
    if (cleared.rowCount !== 1) throw new Error("Expected exactly one disposable deployment provider binding to be cleared");

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }

  const verify = await db.query(
    `SELECT d.status,
            d.provider_deployment_id,
            b.provider_deployment_id AS build_provider_deployment_id,
            o.status AS operation_status,
            o.provider_resource_id
       FROM deployments d
       LEFT JOIN deployment_builds b ON b.deployment_id = d.id
       LEFT JOIN deployment_provider_operations o
         ON o.deployment_id = d.id
        AND o.operation_type = 'vercel-create-deployment'
      WHERE d.id = $1`,
    [expectedDeploymentId],
  );
  const after = verify.rows[0];
  if (after.provider_deployment_id !== null || after.build_provider_deployment_id !== null) {
    throw new Error("Fault injection verification failed: local provider attachment still exists");
  }
  if (after.operation_status !== "OBSERVED" || after.provider_resource_id !== expectedProviderDeploymentId) {
    throw new Error("Fault injection verification failed: provider operation ledger was modified unexpectedly");
  }

  console.log(JSON.stringify({
    result: "NODE_04_18_FAULT_INJECTED_BUILD_ATTACHMENT_LOSS",
    appId: expectedAppId,
    appSlug: expectedAppSlug,
    deploymentId: expectedDeploymentId,
    status: after.status,
    removedLocalBuildAttachment: true,
    clearedDeploymentProviderBinding: true,
    providerOperationPreserved: true,
    operationStatus: after.operation_status,
    providerResourceId: after.provider_resource_id,
    externalProviderDeploymentDeleted: false,
  }, null, 2));
} finally {
  await db.end();
}
