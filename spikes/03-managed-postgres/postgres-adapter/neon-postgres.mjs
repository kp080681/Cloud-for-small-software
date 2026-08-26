const API = "https://console.neon.tech/api/v2";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${required("NEON_API_KEY")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!response.ok) {
    const error = new Error(`Neon API ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export async function createDatabase({ name, regionId = process.env.NEON_REGION_ID }) {
  const project = { name, pg_version: 17 };
  if (regionId) project.region_id = regionId;

  const result = await request("/projects", {
    method: "POST",
    body: JSON.stringify({ project }),
  });

  const created = result?.project;
  if (!created?.id) throw new Error("Neon project creation returned no project ID");

  return {
    project: created,
    branch: result.branch ?? null,
    databases: result.databases ?? [],
    roles: result.roles ?? [],
    endpoints: result.endpoints ?? [],
    connectionUris: result.connection_uris ?? [],
  };
}

export async function getDatabase(projectId) {
  try {
    const result = await request(`/projects/${encodeURIComponent(projectId)}`);
    return result?.project ?? result;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function getConnectionBinding(projectId) {
  const branchResult = await request(`/projects/${encodeURIComponent(projectId)}/branches`);
  const branches = branchResult?.branches ?? [];
  const primary = branches.find((branch) => branch.primary) ?? branches[0];
  if (!primary?.id) throw new Error("Neon project has no branch");

  const endpointResult = await request(`/projects/${encodeURIComponent(projectId)}/endpoints`);
  const endpoints = endpointResult?.endpoints ?? [];
  const endpoint = endpoints.find((item) => item.branch_id === primary.id && item.type === "read_write") ?? endpoints[0];
  if (!endpoint?.id) throw new Error("Neon project has no read/write endpoint");

  const databaseResult = await request(`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(primary.id)}/databases`);
  const databases = databaseResult?.databases ?? [];
  const database = databases.find((item) => item.name === "neondb") ?? databases[0];
  if (!database?.name) throw new Error("Neon project has no database");

  const roleResult = await request(`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(primary.id)}/roles`);
  const roles = roleResult?.roles ?? [];
  const role = roles[0];
  if (!role?.name) throw new Error("Neon project has no database role");

  const query = new URLSearchParams({
    branch_id: primary.id,
    endpoint_id: endpoint.id,
    database_name: database.name,
    role_name: role.name,
    pooled: "true",
  });
  const connectionResult = await request(`/projects/${encodeURIComponent(projectId)}/connection_uri?${query}`);
  const connectionUri = connectionResult?.uri;
  if (!connectionUri) throw new Error("Neon returned no connection URI");

  return {
    projectId,
    branchId: primary.id,
    endpointId: endpoint.id,
    databaseName: database.name,
    roleName: role.name,
    connectionUri,
  };
}

export async function deleteDatabase(projectId) {
  try {
    await request(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    return { deleted: true, alreadyAbsent: false };
  } catch (error) {
    if (error.status === 404) return { deleted: true, alreadyAbsent: true };
    throw error;
  }
}
