import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { healthAttemptAction } from "../src/deployment-recovery-rules.mjs";
import { fetchWorkloadUrl, healthCheckRequestInit } from "../src/workload-http.mjs";
import { assertRemoteProjectMatchesSscApp } from "../src/provider-project-identity.mjs";
import { ensureVercelAuthenticationDisabled } from "../src/vercel-public-access.mjs";

const { Client } = pg;
const TIMEOUT_MS = 8000;
const API = "https://api.vercel.com";

function safeErrorCode(error: any) {
  if (typeof error?.code === "string" && error.code.startsWith("WORKLOAD_")) return error.code;
  if (error?.name === "AbortError") return "HEALTH_CHECK_TIMEOUT";
  if (error instanceof TypeError) return "HEALTH_CHECK_NETWORK_ERROR";
  return "HEALTH_CHECK_ERROR";
}

function teamQuery(extra: Record<string, string> = {}) {
  const query = new URLSearchParams(extra);
  if (process.env.VERCEL_TEAM_ID) query.set("teamId", process.env.VERCEL_TEAM_ID);
  const text = query.toString();
  return text ? `?${text}` : "";
}

function safeProviderErrorBody(body: any) {
  if (!body || typeof body !== "object") return null;
  const error = body.error && typeof body.error === "object" ? body.error : null;
  return {
    error: error ? { code: error.code ?? null, message: error.message ?? null } : null,
    code: body.code ?? null,
    message: body.message ?? null,
  };
}

async function vercelRequest(path: string, options: RequestInit = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) {
    const safe = safeProviderErrorBody(body);
    const error: any = new Error(`Vercel API ${response.status} ${response.statusText}${safe ? `: ${JSON.stringify(safe)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getVercelProject(projectId: string) {
  return vercelRequest(`/v9/projects/${encodeURIComponent(projectId)}${teamQuery()}`);
}

async function updateVercelProject(projectId: string, body: any) {
  return vercelRequest(`/v9/projects/${encodeURIComponent(projectId)}${teamQuery()}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function enforceAnonymousProductionAccess(deployment: any) {
  if (deployment.provider !== "vercel") throw new Error(`Unsupported runtime provider: ${deployment.provider}`);
  if (deployment.runtime_project_id !== deployment.provider_project_id) throw new Error("Runtime project binding mismatch");
  const project = await getVercelProject(deployment.provider_project_id);
  assertRemoteProjectMatchesSscApp(project, {
    workspaceId: deployment.workspace_id,
    appId: deployment.app_id,
    slug: deployment.slug,
    storedProjectName: deployment.provider_project_name,
    allowLegacyStoredBinding: true,
  });
  const result = await ensureVercelAuthenticationDisabled({
    project,
    projectId: project.id,
    trustedVercelProjectResponse: true,
    getProject: getVercelProject,
    updateProject: updateVercelProject,
  });
  if (!result.ok) throw new Error(`Vercel anonymous public access could not be ensured: ${result.result}`);
  return result;
}

export const healthCheck = task({
  id: "ssc-control-plane-health-check",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query(
        `SELECT d.id,d.workspace_id,d.app_id,d.status,d.live_url,d.runtime_project_id,
                a.slug,
                rt.provider,rt.provider_project_id,rt.provider_project_name,
                b.provider_deployment_url,
                COALESCE(p.max_health_attempts,3) AS max_health_attempts
           FROM deployments d
           JOIN apps a ON a.id=d.app_id
           JOIN app_runtimes rt ON rt.app_id=d.app_id
           JOIN deployment_builds b ON b.deployment_id=d.id
           LEFT JOIN app_resource_policies p ON p.app_id=d.app_id
          WHERE d.id=$1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Deployment/build not found: ${payload.deploymentId}`);
      const deployment = result.rows[0];

      if (deployment.status === "LIVE") return { result:"NODE_04_11_REPLAY_NOOP", deploymentId:payload.deploymentId, status:"LIVE", liveUrl:deployment.live_url };
      if (!["DEPLOYING","HEALTH_CHECKING"].includes(deployment.status)) throw new Error(`Health check requires DEPLOYING or HEALTH_CHECKING; current status is ${deployment.status}`);

      const checkUrl = deployment.provider_deployment_url;
      if (!checkUrl) throw new Error("Provider deployment URL is unavailable");

      const publicAccess = await enforceAnonymousProductionAccess(deployment);

      if (deployment.status === "DEPLOYING") {
        await db.query("BEGIN");
        try {
          const started = await db.query(`UPDATE deployments SET status='HEALTH_CHECKING',updated_at=now() WHERE id=$1 AND status='DEPLOYING' RETURNING id`,[payload.deploymentId]);
          if (started.rowCount === 1) await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'DEPLOYING','HEALTH_CHECKING','HEALTH_CHECK_STARTED','Application readiness checks started',$2::jsonb)`,[payload.deploymentId,JSON.stringify({checkUrl,responseBodyStored:false,publicAccess})]);
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
      }

      const countResult = await db.query(`SELECT count(*)::int AS count FROM deployment_health_checks WHERE deployment_id=$1`,[payload.deploymentId]);
      const maxAttempts = Number(deployment.max_health_attempts);
      const attemptAction = healthAttemptAction({ existingAttemptCount: countResult.rows[0].count, maxAttempts });
      if (attemptAction.action === "fail-exhausted") {
        await db.query("BEGIN");
        try {
          const failed = await db.query(`UPDATE deployments SET status='FAILED',error_code='HEALTH_CHECK_FAILED',error_message='Application did not become healthy after readiness checks.',finished_at=now(),updated_at=now() WHERE id=$1 AND status='HEALTH_CHECKING' RETURNING id`,[payload.deploymentId]);
          if (failed.rowCount === 1) await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'HEALTH_CHECKING','FAILED','HEALTH_CHECK_FAILED','Application failed readiness checks',$2::jsonb)`,[payload.deploymentId,JSON.stringify({attempts:maxAttempts,responseBodyStored:false,exhaustedBeforeNextAttempt:true})]);
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
        return { result:"NODE_04_11_FAILED", deploymentId:payload.deploymentId, status:"FAILED", attempts:maxAttempts, errorCode:"HEALTH_CHECK_FAILED", responseBodyStored:false };
      }
      const attemptNumber = attemptAction.attemptNumber;

      const started=Date.now(); let httpStatus:number|null=null; let status="UNHEALTHY"; let errorCode:string|null=null;
      try {
        const { response }=await fetchWorkloadUrl(checkUrl,healthCheckRequestInit({signal:AbortSignal.timeout(TIMEOUT_MS)}));
        httpStatus=response.status; status=response.status>=200&&response.status<400?"HEALTHY":"UNHEALTHY"; if(status!=="HEALTHY")errorCode=`HTTP_${response.status}`; try{await response.body?.cancel()}catch{}
      } catch(error:any){errorCode=safeErrorCode(error)}
      const latencyMs=Date.now()-started;
      await db.query(`INSERT INTO deployment_health_checks (deployment_id,check_url,attempt_number,status,http_status,latency_ms,error_code) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[payload.deploymentId,checkUrl,attemptNumber,status,httpStatus,latencyMs,errorCode]);

      if(status==="HEALTHY"){
        await db.query("BEGIN");
        try {
          await db.query(`UPDATE deployments SET error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1 AND status='HEALTH_CHECKING'`,[payload.deploymentId]);
          await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'HEALTH_CHECKING','HEALTH_CHECKING','HEALTH_CHECK_PASSED','Production deployment passed readiness checks',$2::jsonb)`,[payload.deploymentId,JSON.stringify({attemptNumber,httpStatus,latencyMs,checkUrl,responseBodyStored:false})]);
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
        return {result:"NODE_04_11_HEALTHY",deploymentId:payload.deploymentId,status:"HEALTH_CHECKING",checkUrl,attemptNumber,httpStatus,latencyMs,responseBodyStored:false};
      }

      if(attemptNumber>=maxAttempts){
        await db.query("BEGIN");
        try {
          const failed = await db.query(`UPDATE deployments SET status='FAILED',error_code='HEALTH_CHECK_FAILED',error_message='Application did not become healthy after readiness checks.',finished_at=now(),updated_at=now() WHERE id=$1 AND status='HEALTH_CHECKING' RETURNING id`,[payload.deploymentId]);
          if (failed.rowCount === 1) await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'HEALTH_CHECKING','FAILED','HEALTH_CHECK_FAILED','Application failed readiness checks',$2::jsonb)`,[payload.deploymentId,JSON.stringify({attemptNumber,httpStatus,latencyMs,errorCode,responseBodyStored:false})]);
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
        return {result:"NODE_04_11_FAILED",deploymentId:payload.deploymentId,status:"FAILED",attemptNumber,httpStatus,latencyMs,errorCode,responseBodyStored:false};
      }
      return {result:"NODE_04_11_RETRY_REQUIRED",deploymentId:payload.deploymentId,status:"HEALTH_CHECKING",attemptNumber,attemptsRemaining:attemptAction.attemptsRemaining,httpStatus,latencyMs,errorCode,responseBodyStored:false};
    } finally { await db.end(); }
  },
});
