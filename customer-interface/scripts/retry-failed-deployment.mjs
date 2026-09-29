// Operator tool: fires the same retry path a customer's own "Retry" button
// triggers for a terminally FAILED deployment (distinct from
// resume-stuck-deployment.mjs, which is only for a still-BUILDING,
// stalled deployment). Reuses retryFailedCustomerDeployment exactly as-is,
// called directly as the operator with the real customerId/workspaceId
// looked up from the deployment itself.
//
// Usage:
//   DEPLOYMENT_ID=<uuid> node --env-file=.env.local scripts/retry-failed-deployment.mjs
import { connectDatabase } from "../src/server/db.mjs";
import { retryFailedCustomerDeployment } from "../src/server/customer-deployments.mjs";

if (!process.env.DEPLOYMENT_ID) throw new Error("Missing required environment variable: DEPLOYMENT_ID");

const db = await connectDatabase();
try {
  const deploymentId = process.env.DEPLOYMENT_ID;
  const lookup = await db.query(
    `SELECT d.app_id, a.workspace_id, m.customer_identity_id
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       JOIN customer_workspace_memberships m ON m.workspace_id = a.workspace_id
      WHERE d.id = $1
      LIMIT 1`,
    [deploymentId],
  );
  const row = lookup.rows[0];
  if (!row) throw new Error(`No deployment (joined to an app and an owning workspace membership) found for id: ${deploymentId}`);

  const result = await retryFailedCustomerDeployment(db, {
    customerId: row.customer_identity_id,
    workspaceId: row.workspace_id,
    appId: row.app_id,
    deploymentId,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.end();
}
