const API = "https://api.vercel.com";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

async function request(path, options = {}) {
  const token = required("VERCEL_TOKEN");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!response.ok) {
    const error = new Error(`Vercel API ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export async function createRuntime({ name, repository, rootDirectory }) {
  return request(`/v11/projects${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      name,
      framework: "nextjs",
      rootDirectory,
      gitRepository: {
        type: "github",
        repo: repository,
      },
    }),
  });
}

export async function setEnvironment({ projectId, key, value }) {
  const suffix = teamQuery();
  const joiner = suffix ? "&" : "?";
  return request(`/v10/projects/${encodeURIComponent(projectId)}/env${suffix}${joiner}upsert=true`, {
    method: "POST",
    body: JSON.stringify([
      {
        key,
        value,
        type: "encrypted",
        target: ["production"],
      },
    ]),
  });
}

export async function startDeployment({ name, projectId, owner, repo, ref, sha, rootDirectory }) {
  return request(`/v13/deployments${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      name,
      project: projectId,
      target: "production",
      gitSource: {
        type: "github",
        org: owner,
        repo,
        ref,
        sha,
      },
      projectSettings: {
        framework: "nextjs",
        rootDirectory,
      },
      gitMetadata: {
        remoteUrl: `https://github.com/${owner}/${repo}`,
        commitRef: ref,
        commitSha: sha,
        ci: true,
        ciType: "custom",
      },
    }),
  });
}

export async function getDeployment(deploymentId) {
  return request(`/v13/deployments/${encodeURIComponent(deploymentId)}${teamQuery()}`);
}

export async function waitForDeployment(deploymentId, { timeoutMs = 10 * 60_000, intervalMs = 3_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const deployment = await getDeployment(deploymentId);
    const state = deployment.readyState ?? deployment.status;
    if (state === "READY") return deployment;
    if (["ERROR", "CANCELED"].includes(state)) {
      throw new Error(`Deployment reached terminal state ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Deployment ${deploymentId} timed out after ${timeoutMs}ms`);
}

export function getCandidateUrl(deployment) {
  if (!deployment.url) throw new Error("Deployment did not return a URL");
  return deployment.url.startsWith("http") ? deployment.url : `https://${deployment.url}`;
}

export async function verifyHealth({ baseUrl, expectedMarker, timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true) throw new Error("Health endpoint did not report ok=true");
    if (body?.service !== "ssc-spike-a-test-app") throw new Error("Unexpected service identity");
    if (body?.marker !== expectedMarker) throw new Error("Deployment marker mismatch");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteRuntime(projectId) {
  try {
    await request(`/v9/projects/${encodeURIComponent(projectId)}${teamQuery()}`, { method: "DELETE" });
    return { deleted: true, alreadyAbsent: false };
  } catch (error) {
    if (error.status === 404) return { deleted: true, alreadyAbsent: true };
    throw error;
  }
}
