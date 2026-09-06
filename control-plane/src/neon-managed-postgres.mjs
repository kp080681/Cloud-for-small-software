import { sscManagedDatabaseName } from "./managed-database-lifecycle.mjs";

const API = "https://console.neon.tech/api/v2";

export function neonOrgQuery(extra = {}) {
  const params = new URLSearchParams(extra);
  if (process.env.NEON_ORG_ID) params.set("org_id", process.env.NEON_ORG_ID);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function safeNeonErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  return {
    code: body.code ?? body.error?.code ?? null,
    message: body.message ?? body.error?.message ?? null,
  };
}

export async function neonRequest(path, options = {}) {
  if (!process.env.NEON_API_KEY) throw new Error("Missing NEON_API_KEY");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NEON_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (response.status === 404) {
    const error = new Error("Neon resource not found");
    error.status = 404;
    throw error;
  }
  if (!response.ok) {
    const safe = safeNeonErrorBody(body);
    const error = new Error(`Neon API ${response.status} ${response.statusText}${safe ? `: ${JSON.stringify(safe)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function listNeonProjectsByName(name, { request = neonRequest } = {}) {
  const body = await request(`/projects${neonOrgQuery({ search: name, limit: "100" })}`);
  return (body?.projects ?? []).filter((project) => project?.name === name);
}

export async function listSscCandidateNeonProjects({ request = neonRequest } = {}) {
  const body = await request(`/projects${neonOrgQuery({ search: "ssc-", limit: "400" })}`);
  return body?.projects ?? [];
}

export async function getNeonProject(projectId, { request = neonRequest } = {}) {
  try {
    return await request(`/projects/${encodeURIComponent(projectId)}${neonOrgQuery()}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function createNeonProject({ workspaceId, appId }, { request = neonRequest } = {}) {
  const name = sscManagedDatabaseName({ workspaceId, appId });
  return request(`/projects${neonOrgQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      project: {
        name,
      },
    }),
  });
}

export async function deleteNeonProject(projectId, { request = neonRequest } = {}) {
  try {
    await request(`/projects/${encodeURIComponent(projectId)}${neonOrgQuery()}`, { method: "DELETE" });
    return { deleted: true, notFound: false };
  } catch (error) {
    if (error.status === 404) return { deleted: false, notFound: true };
    throw error;
  }
}

export async function getNeonConnectionUri(resource, { request = neonRequest } = {}) {
  const params = new URLSearchParams({
    database_name: resource.providerDatabaseName,
    role_name: resource.providerRoleName,
    pooled: "true",
  });
  if (resource.providerBranchId) params.set("branch_id", resource.providerBranchId);
  if (resource.providerEndpointId) params.set("endpoint_id", resource.providerEndpointId);
  return request(`/projects/${encodeURIComponent(resource.providerProjectId)}/connection_uri?${params.toString()}`);
}

export async function restoreNeonBranch({ projectId, branchId, sourceBranchId, sourceLsn, sourceTimestamp, preserveUnderName }, { request = neonRequest } = {}) {
  const body = {
    source_branch_id: sourceBranchId,
    ...(sourceLsn ? { source_lsn: sourceLsn } : {}),
    ...(sourceTimestamp ? { source_timestamp: sourceTimestamp } : {}),
    ...(preserveUnderName ? { preserve_under_name: preserveUnderName } : {}),
  };
  return request(`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/restore${neonOrgQuery()}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getNeonOperation({ projectId, operationId }, { request = neonRequest } = {}) {
  return request(`/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}${neonOrgQuery()}`);
}

export function operationIdsFromNeonResponse(body) {
  const operations = Array.isArray(body?.operations) ? body.operations : body?.operation ? [body.operation] : [];
  return operations.map((operation) => operation?.id).filter(Boolean);
}

export function neonOperationStatus(operation) {
  return String(operation?.status ?? operation?.operation?.status ?? "").toLowerCase();
}

export async function waitForNeonOperations({ projectId, operationIds, timeoutMs = 120000, pollMs = 2000 }, { getOperation = getNeonOperation, sleep = defaultSleep } = {}) {
  const ids = [...new Set(operationIds.filter(Boolean))];
  if (!ids.length) return [];
  const deadline = Date.now() + timeoutMs;
  const completed = new Map();
  while (Date.now() < deadline) {
    for (const operationId of ids) {
      if (completed.has(operationId)) continue;
      const body = await getOperation({ projectId, operationId });
      const operation = body?.operation ?? body;
      const status = neonOperationStatus(operation);
      if (["finished", "succeeded", "success", "completed"].includes(status)) {
        completed.set(operationId, { operationId, status });
      } else if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        throw new Error(`Neon operation ${operationId} failed with status ${status}`);
      }
    }
    if (completed.size === ids.length) return [...completed.values()];
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for Neon operations: ${ids.join(",")}`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeNeonProjectResource(body) {
  const project = body?.project ?? body;
  const branch = body?.branch ?? body?.branches?.[0] ?? project?.default_branch ?? null;
  const endpoint = body?.endpoint ?? body?.endpoints?.[0] ?? null;
  const database = body?.database ?? body?.databases?.[0] ?? null;
  const role = body?.role ?? body?.roles?.[0] ?? null;
  const providerProjectId = project?.id;
  if (!providerProjectId) throw new Error("Neon project response did not include project id");
  const providerProjectName = project?.name;
  return {
    providerProjectId,
    providerProjectName,
    providerBranchId: branch?.id ?? project?.default_branch_id ?? null,
    providerEndpointId: endpoint?.id ?? null,
    providerDatabaseId: database?.id ?? null,
    providerDatabaseName: database?.name ?? "neondb",
    providerRoleName: role?.name ?? "neondb_owner",
  };
}
