// Custom domains on the dashboard (2026-10-30). Decides who may connect,
// check or remove a domain and records the request; the engine task
// (control-plane/trigger/manage-custom-domain.ts) does every provider call
// and writes back the records to add and the status.

import { enforceRateLimit } from "../shared/control-plane/rate-limit.mjs";
import {
  CUSTOM_DOMAIN_STATUS as S,
  normalizeCustomDomain,
  stepsForProvider,
  statusMessage,
} from "../shared/control-plane/custom-domain.mjs";
import { triggerCustomDomainTask } from "./customer-deployments.mjs";

const CHANGE_LIMIT = { action: "custom_domain_change", limit: 10, windowSeconds: 3600 };
const CHECK_LIMIT = { action: "custom_domain_check", limit: 120, windowSeconds: 3600 };

function domainError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

async function loadOwnedApp(db, { customerId, workspaceId, appId }) {
  const result = await db.query(
    `SELECT a.id, a.workspace_id,
            EXISTS (SELECT 1 FROM deployments d WHERE d.app_id = a.id AND d.status = 'LIVE') AS has_live
       FROM customer_workspace_memberships m
       JOIN apps a ON a.workspace_id = m.workspace_id
      WHERE m.customer_identity_id = $1
        AND m.workspace_id = $2
        AND a.id = $3
        AND a.deleted_at IS NULL`,
    [customerId, workspaceId, appId],
  );
  const app = result.rows[0];
  if (!app) throw domainError("APP_NOT_FOUND", "Application not found in this workspace.", 404);
  return app;
}

async function loadCurrentDomain(db, appId) {
  const result = await db.query(
    `SELECT * FROM app_custom_domains WHERE app_id = $1 AND status <> 'REMOVED' ORDER BY created_at DESC LIMIT 1`,
    [appId],
  );
  return result.rows[0] ?? null;
}

function cleanRecords(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item.type === "string" && typeof item.value === "string")
    .slice(0, 12)
    .map((item) => ({
      type: item.type,
      name: String(item.name ?? "@"),
      value: item.value,
      fqdn: typeof item.fqdn === "string" ? item.fqdn : null,
      purpose: typeof item.purpose === "string" ? item.purpose : null,
    }));
}

// What the dashboard and MCP get to see. Only public DNS facts and plain
// messages; nothing from the provider is passed through raw.
export function safeCustomDomain(row) {
  if (!row || row.status === S.REMOVED) return null;
  const providerName = row.dns_provider_name ?? null;
  const steps = stepsForProvider(row.dns_provider_key);
  const status = row.status;
  return {
    id: row.id,
    domain: row.domain,
    url: status === S.ACTIVE ? `https://${row.domain}` : null,
    status,
    message: statusMessage({ status, domain: row.domain, providerName, problem: row.problem }),
    problemCode: row.problem_code ?? null,
    includeWww: Boolean(row.include_www),
    wwwReady: Boolean(row.www_ready),
    provider: providerName ? { key: row.dns_provider_key, name: providerName } : null,
    steps,
    // Once live, only the www record can still be missing (it's optional).
    records: status === S.NEEDS_DNS || status === S.SECURING || (status === S.PENDING && row.problem_code === "OWNERSHIP_PROOF_NEEDED")
      ? cleanRecords(row.records)
      : status === S.ACTIVE && row.include_www && !row.www_ready
        ? cleanRecords(row.records).filter((record) => record.purpose === "www")
        : [],
    remove: status === S.NEEDS_DNS ? cleanRecords(row.conflicts) : [],
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    waitingForProof: status === S.PENDING && row.problem_code === "OWNERSHIP_PROOF_NEEDED",
    checking: Boolean(row.check_requested_at && (!row.last_checked_at || new Date(row.check_requested_at) > new Date(row.last_checked_at))),
  };
}

export async function getAppCustomDomain(db, { customerId, workspaceId, appId }) {
  await loadOwnedApp(db, { customerId, workspaceId, appId });
  return { domain: safeCustomDomain(await loadCurrentDomain(db, appId)) };
}

export async function connectCustomDomain(db, { customerId, workspaceId, appId, domain: input, trigger = triggerCustomDomainTask }) {
  const app = await loadOwnedApp(db, { customerId, workspaceId, appId });
  const domain = normalizeCustomDomain(input);
  const existing = await loadCurrentDomain(db, appId);
  if (existing) {
    if (existing.domain === domain) return { domain: safeCustomDomain(existing), alreadyConnected: true };
    throw domainError("CUSTOM_DOMAIN_EXISTS", `This app is already connected to ${existing.domain}. Remove it first to use a different domain.`, 409);
  }
  if (!app.has_live) throw domainError("APP_NOT_LIVE", "Put this app live first, then connect your domain.", 409);

  // One app per domain across all of Utplava, counting the www that comes
  // with an apex domain.
  const taken = await db.query(
    `SELECT 1 FROM app_custom_domains
      WHERE status <> 'REMOVED'
        AND (domain = $1 OR (include_www AND 'www.' || domain = $1) OR domain = 'www.' || $1)
      LIMIT 1`,
    [domain],
  );
  if (taken.rowCount > 0) throw domainError("DOMAIN_IN_USE", `${domain} is already connected to another app on Utplava.`, 409);

  await enforceRateLimit(db, { workspaceId, ...CHANGE_LIMIT });
  let row;
  try {
    const inserted = await db.query(
      `INSERT INTO app_custom_domains (workspace_id, app_id, domain, status, check_requested_at)
       VALUES ($1, $2, $3, 'PENDING', now())
       RETURNING *`,
      [workspaceId, appId, domain],
    );
    row = inserted.rows[0];
  } catch (error) {
    if (error?.code === "23505") throw domainError("DOMAIN_IN_USE", `${domain} is already connected to an app on Utplava.`, 409);
    throw error;
  }
  try {
    await trigger({ domainId: row.id, action: "attach" });
  } catch (error) {
    // Nothing was attached; don't leave the domain reserved.
    await db.query(`UPDATE app_custom_domains SET status = 'REMOVED', removed_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
    throw error;
  }
  return { domain: safeCustomDomain(row), alreadyConnected: false };
}

export async function checkCustomDomain(db, { customerId, workspaceId, appId, trigger = triggerCustomDomainTask }) {
  await loadOwnedApp(db, { customerId, workspaceId, appId });
  const row = await loadCurrentDomain(db, appId);
  if (!row) throw domainError("CUSTOM_DOMAIN_NOT_FOUND", "This app has no custom domain.", 404);
  if (row.status === S.REMOVING || row.status === S.FAILED) return { domain: safeCustomDomain(row) };
  // Back-to-back clicks reuse the check already under way.
  const recent = row.check_requested_at && Date.now() - new Date(row.check_requested_at).getTime() < 10_000;
  if (!recent) {
    await enforceRateLimit(db, { workspaceId, ...CHECK_LIMIT });
    await trigger({ domainId: row.id, action: row.status === S.PENDING ? "attach" : "check" });
    const updated = await db.query(
      `UPDATE app_custom_domains SET check_requested_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id],
    );
    return { domain: safeCustomDomain(updated.rows[0] ?? row) };
  }
  return { domain: safeCustomDomain(row) };
}

export async function removeCustomDomain(db, { customerId, workspaceId, appId, trigger = triggerCustomDomainTask }) {
  await loadOwnedApp(db, { customerId, workspaceId, appId });
  const row = await loadCurrentDomain(db, appId);
  if (!row) return { removed: true };
  await enforceRateLimit(db, { workspaceId, ...CHANGE_LIMIT });
  await db.query(`UPDATE app_custom_domains SET status = 'REMOVING', updated_at = now() WHERE id = $1 AND status <> 'REMOVED'`, [row.id]);
  await trigger({ domainId: row.id, action: "remove" });
  return { removed: false, removing: true, domain: row.domain };
}

// Errors from this module carry messages written for the customer; pass
// those through (the generic helper only returns a code). Anything else,
// including database errors, stays a bare code.
export function customDomainErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  if (error?.name === "RateLimitError" || code === "WORKSPACE_RATE_LIMIT_REACHED") {
    return Response.json({ error: code, message: "That's a lot of changes in a short time. Wait a few minutes and try again." }, { status: 429 });
  }
  const isSqlState = /^[0-9A-Z]{5}$/.test(code);
  const message = status >= 400 && status < 500 && !isSqlState && typeof error?.message === "string" ? error.message : null;
  return Response.json(message ? { error: code, message } : { error: code }, { status });
}
