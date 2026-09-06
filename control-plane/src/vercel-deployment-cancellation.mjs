const API = "https://api.vercel.com";

export const RemoteContainment = Object.freeze({
  CANCEL_CONFIRMED: "REMOTE_CANCEL_CONFIRMED",
  ALREADY_TERMINAL: "REMOTE_ALREADY_TERMINAL",
  CANCEL_PENDING_RECONCILIATION: "REMOTE_CANCEL_PENDING_RECONCILIATION",
  CONTAINMENT_FAILED: "REMOTE_CONTAINMENT_FAILED",
});

const TERMINAL_STATES = new Set(["READY", "ERROR", "CANCELED", "CANCELLED"]);

function teamQuery(teamId = process.env.VERCEL_TEAM_ID) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

function providerStatus(deployment) {
  const status = deployment?.readyState ?? deployment?.status ?? null;
  return status ? String(status).toUpperCase() : null;
}

export function isTerminalVercelDeploymentStatus(status) {
  return TERMINAL_STATES.has(String(status ?? "").toUpperCase());
}

function eventTypeForOutcome(outcome) {
  if (outcome.remoteContainment === RemoteContainment.CANCEL_CONFIRMED) return "PROVIDER_CANCEL_CONFIRMED";
  if (outcome.remoteContainment === RemoteContainment.ALREADY_TERMINAL) return "PROVIDER_ALREADY_TERMINAL";
  return "PROVIDER_CANCEL_FAILED";
}

function safeOutcome(outcome) {
  return {
    provider: "vercel",
    providerDeploymentId: outcome.providerDeploymentId,
    providerStatus: outcome.providerStatus ?? null,
    remoteContainment: outcome.remoteContainment,
    retryable: outcome.retryable === true,
    cancelRequestSent: outcome.cancelRequestSent === true,
    providerHttpStatus: outcome.providerHttpStatus ?? null,
    reason: outcome.reason ?? null,
    responseBodyStored: false,
  };
}

async function vercelJsonRequest(path, { method = "GET", fetchImpl = globalThis.fetch, token, teamId } = {}) {
  const response = await fetchImpl(`${API}${path}${teamQuery(teamId)}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  let body = null;
  if (response.ok) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  } else {
    try {
      await response.body?.cancel();
    } catch {}
  }
  return { response, body };
}

export async function cancelVercelDeployment({
  providerDeploymentId,
  fetchImpl = globalThis.fetch,
  token = process.env.VERCEL_TOKEN,
  teamId = process.env.VERCEL_TEAM_ID,
} = {}) {
  if (!providerDeploymentId) {
    return {
      providerDeploymentId,
      providerStatus: "MISSING_PROVIDER_DEPLOYMENT_ID",
      remoteContainment: RemoteContainment.ALREADY_TERMINAL,
      retryable: false,
      cancelRequestSent: false,
      reason: "missing-provider-deployment-id",
    };
  }
  if (!token) {
    return {
      providerDeploymentId,
      providerStatus: null,
      remoteContainment: RemoteContainment.CONTAINMENT_FAILED,
      retryable: false,
      cancelRequestSent: false,
      reason: "missing-vercel-token",
    };
  }

  const encodedId = encodeURIComponent(providerDeploymentId);
  let before;
  try {
    before = await vercelJsonRequest(`/v13/deployments/${encodedId}`, { fetchImpl, token, teamId });
  } catch {
    return {
      providerDeploymentId,
      providerStatus: null,
      remoteContainment: RemoteContainment.CANCEL_PENDING_RECONCILIATION,
      retryable: true,
      cancelRequestSent: false,
      reason: "provider-lookup-network-failed",
    };
  }
  if (before.response.status === 404) {
    return {
      providerDeploymentId,
      providerStatus: "NOT_FOUND",
      remoteContainment: RemoteContainment.ALREADY_TERMINAL,
      retryable: false,
      cancelRequestSent: false,
      providerHttpStatus: 404,
      reason: "provider-deployment-not-found",
    };
  }
  if (!before.response.ok) {
    return {
      providerDeploymentId,
      providerStatus: null,
      remoteContainment: before.response.status >= 500 || before.response.status === 429
        ? RemoteContainment.CANCEL_PENDING_RECONCILIATION
        : RemoteContainment.CONTAINMENT_FAILED,
      retryable: before.response.status >= 500 || before.response.status === 429,
      cancelRequestSent: false,
      providerHttpStatus: before.response.status,
      reason: "provider-lookup-failed",
    };
  }

  const beforeStatus = providerStatus(before.body);
  if (isTerminalVercelDeploymentStatus(beforeStatus)) {
    return {
      providerDeploymentId,
      providerStatus: beforeStatus,
      remoteContainment: RemoteContainment.ALREADY_TERMINAL,
      retryable: false,
      cancelRequestSent: false,
      providerHttpStatus: before.response.status,
      reason: "provider-already-terminal",
    };
  }

  let cancel;
  try {
    cancel = await vercelJsonRequest(`/v12/deployments/${encodedId}/cancel`, {
      method: "PATCH",
      fetchImpl,
      token,
      teamId,
    });
  } catch {
    return {
      providerDeploymentId,
      providerStatus: beforeStatus,
      remoteContainment: RemoteContainment.CANCEL_PENDING_RECONCILIATION,
      retryable: true,
      cancelRequestSent: true,
      reason: "provider-cancel-network-failed",
    };
  }
  if (cancel.response.ok) {
    const cancelStatus = providerStatus(cancel.body);
    if (cancelStatus === "CANCELED" || cancelStatus === "CANCELLED") {
      return {
        providerDeploymentId,
        providerStatus: cancelStatus,
        remoteContainment: RemoteContainment.CANCEL_CONFIRMED,
        retryable: false,
        cancelRequestSent: true,
        providerHttpStatus: cancel.response.status,
        reason: "provider-cancel-confirmed",
      };
    }
  }

  let after;
  try {
    after = await vercelJsonRequest(`/v13/deployments/${encodedId}`, { fetchImpl, token, teamId });
  } catch {
    return {
      providerDeploymentId,
      providerStatus: beforeStatus,
      remoteContainment: RemoteContainment.CANCEL_PENDING_RECONCILIATION,
      retryable: true,
      cancelRequestSent: true,
      providerHttpStatus: cancel.response.status,
      reason: "provider-reconcile-network-failed",
    };
  }
  if (after.response.status === 404) {
    return {
      providerDeploymentId,
      providerStatus: "NOT_FOUND",
      remoteContainment: RemoteContainment.ALREADY_TERMINAL,
      retryable: false,
      cancelRequestSent: true,
      providerHttpStatus: 404,
      reason: "provider-deployment-not-found-after-cancel",
    };
  }
  const afterStatus = after.response.ok ? providerStatus(after.body) : null;
  if (afterStatus === "CANCELED" || afterStatus === "CANCELLED") {
    return {
      providerDeploymentId,
      providerStatus: afterStatus,
      remoteContainment: RemoteContainment.CANCEL_CONFIRMED,
      retryable: false,
      cancelRequestSent: true,
      providerHttpStatus: after.response.status,
      reason: "provider-cancel-confirmed-after-reconcile",
    };
  }
  if (isTerminalVercelDeploymentStatus(afterStatus)) {
    return {
      providerDeploymentId,
      providerStatus: afterStatus,
      remoteContainment: RemoteContainment.ALREADY_TERMINAL,
      retryable: false,
      cancelRequestSent: true,
      providerHttpStatus: after.response.status,
      reason: "provider-raced-to-terminal",
    };
  }

  const retryable = cancel.response.status >= 500 || cancel.response.status === 429 || after.response.status >= 500 || after.response.status === 429;
  return {
    providerDeploymentId,
    providerStatus: afterStatus ?? beforeStatus,
    remoteContainment: retryable
      ? RemoteContainment.CANCEL_PENDING_RECONCILIATION
      : RemoteContainment.CONTAINMENT_FAILED,
    retryable,
    cancelRequestSent: true,
    providerHttpStatus: cancel.response.ok ? after.response.status : cancel.response.status,
    reason: cancel.response.ok ? "provider-cancel-not-yet-reconciled" : "provider-cancel-failed",
  };
}

export async function recordRemoteBuildContainment(
  db,
  {
    deploymentId,
    fromStatus,
    providerDeploymentId,
    reason,
    cancelDeployment = cancelVercelDeployment,
  },
) {
  const existing = await db.query(
    `SELECT event_type, metadata
      FROM deployment_events
      WHERE deployment_id=$1
        AND event_type IN ('PROVIDER_CANCEL_CONFIRMED','PROVIDER_ALREADY_TERMINAL','PROVIDER_CANCEL_FAILED')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [deploymentId],
  );
  if (existing.rowCount === 1) {
    const metadata = existing.rows[0].metadata ?? {};
    if (existing.rows[0].event_type !== "PROVIDER_CANCEL_FAILED" || metadata.retryable !== true) {
      return { alreadyRecorded: true, outcome: metadata };
    }
  }

  await db.query(
    `INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata)
     VALUES ($1,$2,$2,'PROVIDER_CANCEL_REQUESTED','Provider deployment cancellation requested',$3::jsonb)`,
    [
      deploymentId,
      fromStatus,
      JSON.stringify({
        provider: "vercel",
        providerDeploymentId,
        reason,
        responseBodyStored: false,
      }),
    ],
  );

  const outcome = await cancelDeployment({ providerDeploymentId });
  const evidence = safeOutcome(outcome);
  await db.query(
    `INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata)
     VALUES ($1,$2,$2,$3,$4,$5::jsonb)`,
    [
      deploymentId,
      fromStatus,
      eventTypeForOutcome(outcome),
      outcome.remoteContainment === RemoteContainment.CANCEL_CONFIRMED
        ? "Provider deployment cancellation confirmed"
        : outcome.remoteContainment === RemoteContainment.ALREADY_TERMINAL
          ? "Provider deployment was already terminal or absent"
          : "Provider deployment cancellation requires reconciliation",
      JSON.stringify({ ...evidence, reason }),
    ],
  );

  return { alreadyRecorded: false, outcome: evidence };
}
