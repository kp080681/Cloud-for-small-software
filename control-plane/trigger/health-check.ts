import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { healthAttemptAction } from "../src/deployment-recovery-rules.mjs";

const { Client } = pg;
const TIMEOUT_MS = 8000;

function safeErrorCode(error: any) {
  if (error?.name === "AbortError") return "HEALTH_CHECK_TIMEOUT";
  if (error instanceof TypeError) return "HEALTH_CHECK_NETWORK_ERROR";
  return "HEALTH_CHECK_ERROR";
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
        `SELECT d.id,d.status,d.live_url,b.provider_deployment_url,
                COALESCE(p.max_health_attempts,3) AS max_health_attempts
           FROM deployments d JOIN deployment_builds b ON b.deployment_id=d.id
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
      if (new URL(checkUrl).protocol !== "https:") throw new Error("Health check URL must use HTTPS");

      if (deployment.status === "DEPLOYING") {
        await db.query("BEGIN");
        try {
          const started = await db.query(`UPDATE deployments SET status='HEALTH_CHECKING',updated_at=now() WHERE id=$1 AND status='DEPLOYING' RETURNING id`,[payload.deploymentId]);
          if (started.rowCount === 1) await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'DEPLOYING','HEALTH_CHECKING','HEALTH_CHECK_STARTED','Application readiness checks started',$2::jsonb)`,[payload.deploymentId,JSON.stringify({checkUrl,responseBodyStored:false})]);
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
        const response=await fetch(checkUrl,{method:"GET",redirect:"follow",signal:AbortSignal.timeout(TIMEOUT_MS),headers:{"User-Agent":"Small-Software-Cloud-Health-Check/1.0","Authorization":process.env.VERCEL_TOKEN?`Bearer ${process.env.VERCEL_TOKEN}`:""}});
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
