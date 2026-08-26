import { neon } from "@neondatabase/serverless";

function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return neon(process.env.DATABASE_URL);
}

export async function ensureSchema() {
  await sql()`
    create table if not exists spike_d_deployments (
      deployment_key text primary key,
      status text not null,
      repository text not null,
      git_sha text not null,
      runtime_name text not null,
      runtime_project_id text,
      provider_deployment_id text,
      live_url text,
      attempts integer not null default 0,
      forced_failure_recorded boolean not null default false,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
}

export async function createDeployment({ deploymentKey, repository, gitSha, runtimeName }) {
  const rows = await sql()`
    insert into spike_d_deployments (deployment_key, status, repository, git_sha, runtime_name)
    values (${deploymentKey}, 'QUEUED', ${repository}, ${gitSha}, ${runtimeName})
    on conflict (deployment_key) do update set updated_at = now()
    returning *
  `;
  return rows[0];
}

export async function getDeployment(deploymentKey) {
  const rows = await sql()`select * from spike_d_deployments where deployment_key = ${deploymentKey}`;
  return rows[0] ?? null;
}

export async function beginAttempt(deploymentKey) {
  const rows = await sql()`
    update spike_d_deployments
    set attempts = attempts + 1, status = 'RUNNING', updated_at = now()
    where deployment_key = ${deploymentKey}
    returning *
  `;
  if (!rows[0]) throw new Error(`Unknown deployment ${deploymentKey}`);
  return rows[0];
}

export async function recordRuntime(deploymentKey, projectId) {
  const rows = await sql()`
    update spike_d_deployments
    set runtime_project_id = ${projectId}, updated_at = now()
    where deployment_key = ${deploymentKey}
    returning *
  `;
  return rows[0];
}

export async function claimForcedFailure(deploymentKey) {
  const rows = await sql()`
    update spike_d_deployments
    set forced_failure_recorded = true, last_error = 'FORCED_RETRY_AFTER_RUNTIME_CREATION', updated_at = now()
    where deployment_key = ${deploymentKey} and forced_failure_recorded = false
    returning deployment_key
  `;
  return rows.length === 1;
}

export async function recordProviderDeployment(deploymentKey, providerDeploymentId) {
  await sql()`
    update spike_d_deployments
    set provider_deployment_id = ${providerDeploymentId}, status = 'DEPLOYING', updated_at = now()
    where deployment_key = ${deploymentKey}
  `;
}

export async function markLive(deploymentKey, liveUrl) {
  const rows = await sql()`
    update spike_d_deployments
    set status = 'LIVE', live_url = ${liveUrl}, last_error = null, updated_at = now()
    where deployment_key = ${deploymentKey}
    returning *
  `;
  return rows[0];
}

export async function markFailed(deploymentKey, message) {
  await sql()`
    update spike_d_deployments
    set status = 'RETRYABLE_ERROR', last_error = ${message}, updated_at = now()
    where deployment_key = ${deploymentKey}
  `;
}
