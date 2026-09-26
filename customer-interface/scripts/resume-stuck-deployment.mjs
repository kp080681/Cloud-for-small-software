// Operator tool: manually fires the exact same resume path a customer's own
// browser triggers while polling an active deployment (see
// getCustomerDeploymentProgressWithResume in customer-deployments.mjs).
// Built for one specific real incident: a customer's deployment stalled
// overnight with no one's browser open to trigger the usual resume check.
// Reuses resumeCustomerDeployment exactly as-is — same eligibility checks,
// same compare-and-swap claim, same orchestrator re-trigger — just called
// directly as the operator instead of through the customer's own session,
// with the real customerId/workspaceId looked up from the deployment
// itself rather than supplied by a logged-in customer.
//
// Usage:
//   DEPLOYMENT_ID=<uuid> node --env-file=.env.local scripts/resume-stuck-deployment.mjs
import { connectDatabase } from "../src/server/db.mjs";
import { resumeCustomerDeployment } from "../src/server/customer-deployments.mjs";

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

  const result = await resumeCustomerDeployment(db, {
    customerId: row.customer_identity_id,
    workspaceId: row.workspace_id,
    appId: row.app_id,
    deploymentId,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.end();
}
