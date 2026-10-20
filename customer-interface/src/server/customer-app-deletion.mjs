// Customer-facing app deletion (2026-10-20). Starts the engine's existing
// ssc-control-plane-delete-app task, which removes the Vercel project, any
// managed database and the app's secrets, refuses to touch a provider
// project it can't prove belongs to this app, and keeps deployment history.
// This module only decides whether a request is allowed and starts it.

import crypto from "node:crypto";
import { triggerAppDeletionTask } from "./customer-deployments.mjs";

const IN_FLIGHT = new Set(["REQUESTED", "DELETING", "PROVIDER_DELETED"]);

export async function requestCustomerAppDeletion(
  db,
  { customerId, workspaceId, appId, confirmName, trigger = triggerAppDeletionTask, keyFactory = () => `del_${crypto.randomUUID().replaceAll("-", "")}` },
) {
  const appResult = await db.query(
    `SELECT a.id, a.name, a.deleted_at
       FROM customer_workspace_memberships m
       JOIN apps a ON a.workspace_id = m.workspace_id
      WHERE m.customer_identity_id = $1
        AND m.workspace_id = $2
        AND a.id = $3`,
    [customerId, workspaceId, appId],
  );
  const app = appResult.rows[0];
  if (!app) throw Object.assign(new Error("Application not found in this workspace."), { status: 404, code: "APP_NOT_FOUND" });
  if (app.deleted_at) return { status: "DELETED" };

  // Typing the exact name is the safeguard against deleting the wrong app.
  if (typeof confirmName !== "string" || confirmName.trim() !== app.name) {
    throw Object.assign(new Error("Type the app's name exactly to confirm."), { status: 400, code: "DELETE_CONFIRMATION_MISMATCH" });
  }

  // Deleting mid-deploy could let an in-flight build land after the project
  // is gone; ask the person to wait for it to finish instead.
  const running = await db.query(
    `SELECT 1 FROM deployments
      WHERE app_id = $1
        AND updated_at > now() - interval '30 minutes'
        AND (status IN ('QUEUED','PROVISIONING','BUILDING','DEPLOYING','HEALTH_CHECKING')
             OR (status = 'ANALYZING' AND orchestrator_run_id IS NOT NULL))
      LIMIT 1`,
    [appId],
  );
  if (running.rowCount > 0) {
    throw Object.assign(new Error("A deployment is running."), { status: 409, code: "DEPLOYMENT_IN_PROGRESS" });
  }

  const existing = await db.query(
    `SELECT deletion_key, status, (updated_at > now() - interval '10 minutes') AS recent
       FROM app_deletions WHERE app_id = $1`,
    [appId],
  );
  const prior = existing.rows[0];
  if (prior?.status === "COMPLETED") return { status: "DELETED" };
  if (prior && IN_FLIGHT.has(prior.status) && prior.recent) return { status: "DELETING", alreadyRequested: true };

  // The engine binds a deletion to its key; a retry must reuse it.
  const deletionKey = prior?.deletion_key ?? keyFactory();
  await trigger({ appId, workspaceId, deletionKey });
  return { status: "DELETING", alreadyRequested: false };
}
