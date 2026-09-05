const BUILD_ATTACH_STATUS = "BUILDING";
const RUNTIME_ATTACH_STATUSES = new Set(["PROVISIONING", "BUILDING"]);
const APP_DELETED_STATES = new Set(["DELETING", "DELETED"]);

export function providerCreateClaimDecision(operation) {
  if (!operation) throw new Error("Provider operation is required for claim decision");
  if (operation.provider_resource_id) {
    return { action: "observed", claimed: false };
  }
  if (operation.status === "INTENT_RECORDED" || operation.status === "FAILED") {
    return { action: "claim-create", claimed: false };
  }
  if (operation.status === "CREATE_REQUESTED") {
    return { action: "in-flight", claimed: false };
  }
  if (operation.status === "AMBIGUOUS") {
    return { action: "ambiguous", claimed: false };
  }
  return { action: "blocked", claimed: false, status: operation.status };
}

export async function claimProviderCreateOperation(db, { operationId }) {
  const claimed = await db.query(
    `UPDATE deployment_provider_operations
        SET status='CREATE_REQUESTED', updated_at=now()
      WHERE id=$1
        AND status IN ('INTENT_RECORDED','FAILED')
        AND provider_resource_id IS NULL
      RETURNING id, deployment_id, status, provider_resource_id, source_commit_sha`,
    [operationId],
  );
  if (claimed.rowCount === 1) {
    return { claimed: true, operation: claimed.rows[0] };
  }

  const current = await db.query(
    `SELECT id, deployment_id, status, provider_resource_id, source_commit_sha
       FROM deployment_provider_operations
      WHERE id=$1`,
    [operationId],
  );
  if (current.rowCount !== 1) throw new Error(`Provider operation disappeared during claim: ${operationId}`);
  return { claimed: false, operation: current.rows[0] };
}

export function buildResultAttachmentDecision({ deploymentStatus, operationStatus }) {
  deploymentStatus = deploymentStatus ?? arguments[0]?.deployment_status;
  operationStatus = operationStatus ?? arguments[0]?.operation_status;
  if (deploymentStatus !== BUILD_ATTACH_STATUS) {
    return { action: "trace-stale", reason: `deployment_status_${deploymentStatus}` };
  }
  if (!["INTENT_RECORDED", "CREATE_REQUESTED", "OBSERVED"].includes(operationStatus)) {
    return { action: "trace-stale", reason: `operation_status_${operationStatus}` };
  }
  return { action: "attach" };
}

export function runtimeResultAttachmentDecision({ appDeletedAt = null, deploymentStatus }) {
  appDeletedAt = appDeletedAt ?? arguments[0]?.app_deleted_at ?? null;
  deploymentStatus = deploymentStatus ?? arguments[0]?.deployment_status;
  if (appDeletedAt) return { action: "trace-stale", reason: "app_deleted" };
  if (APP_DELETED_STATES.has(deploymentStatus)) return { action: "trace-stale", reason: `deployment_status_${deploymentStatus}` };
  if (!RUNTIME_ATTACH_STATUSES.has(deploymentStatus)) {
    return { action: "trace-stale", reason: `deployment_status_${deploymentStatus}` };
  }
  return { action: "attach" };
}
