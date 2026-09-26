import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  buildRecoveryAction,
  matchingSscDeployments,
  providerDeploymentUrl,
  sscBuildOperationKey,
  sscDeploymentMeta,
} from "../src/vercel-deployment-recovery.mjs";
import { withTransientRetry } from "../src/transient-retry.mjs";
import {
  assertProviderProjectNotOwnedByAnotherApp,
  assertRemoteProjectMatchesSscApp,
} from "../src/provider-project-identity.mjs";
import {
  assertProviderOperationBelongsToDeployment,
  assertRuntimeMatchesDeployment,
  assertSscProviderResourceIdentity,
} from "../src/tenant-boundary.mjs";
import {
  buildResultAttachmentDecision,
  claimProviderCreateOperation,
  providerCreateClaimDecision,
} from "../src/provider-mutation-fencing.mjs";
import { ensureGitAutoDeploymentsDisabled } from "../src/vercel-project-config.mjs";
import { ensureBuildOperationWithinWorkspaceLimit } from "../src/workspace-resource-policy.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";

function teamQuery(extra: Record<string, string> = {}) {
  const query = new URLSearchParams(extra);
  if (process.env.VERCEL_TEAM_ID) query.set("teamId", process.env.VERCEL_TEAM_ID);
  const text = query.toString();
  return text ? `?${text}` : "";
}

function safeProviderErrorBody(body: any) {
  if (!body || typeof body !== "object") return null;
  const error = body.error && typeof body.error === "object" ? body.error : null;
  return { error: error ? { code: error.code ?? null, message: error.message ?? null } : null, code: body.code ?? null, message: body.message ?? null };
}

// 25s bound on every Vercel API call. Found missing after a real customer
// deployment ("math-game") got stuck at BUILDING with no provider_deployment_id
// and no error, twice in a row, even through the self-healing resume path —
// traced to this exact fetch() having no timeout at all: if Vercel's API
// hangs rather than erroring, nothing ever throws, so withTransientRetry
// never triggers (it only reacts to a thrown, classified error) and even a
// fresh orchestrator resume just re-issues the same unprotected call and
// hangs again. A timeout here throws a real, classified, retryable error
// instead, so this failure mode now flows through the same recovery path
// every other Vercel error already does.
const VERCEL_REQUEST_TIMEOUT_MS = 25_000;

async function vercelRequest(path: string, options: RequestInit = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), VERCEL_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) }, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === "AbortError") { const timeoutError: any = new Error(`Vercel API request timed out after ${VERCEL_REQUEST_TIMEOUT_MS}ms: ${path}`); timeoutError.isTimeout = true; throw timeoutError; }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
  const text = await response.text(); let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) { const safe = safeProviderErrorBody(body); const error: any = new Error(`Vercel API ${response.status} ${response.statusText}${safe ? `: ${JSON.stringify(safe)}` : ""}`); error.status=response.status; error.safeBody=safe; throw error; }
  return body;
}

// Utplava's own framework taxonomy (project-detection.mjs: exactly "nextjs"
// or "nodejs") isn't the same as Vercel's own projectSettings.framework
// enum, which wants "node" for a plain Node.js app, not "nodejs". Every
// prior real deployment (dealupwebsite, Vantage, DealUp Website) was
// Next.js, where the two values happen to already match — this is the
// first plain Node.js app to ever hit this exact code path, and Vercel's
// API correctly rejected the mismatched value with a 400. Confirmed live,
// with the actual Vercel error message, thanks to the BUILD_EXECUTION_ERROR
// wrapper above — this bug would have been invisible without it.
function toVercelFrameworkValue(framework: string) {
  if (framework === "nodejs") return "node";
  return framework;
}

function classifyProviderError(error: any) {
  if(error?.isTimeout)return{classification:"PROVIDER_TIMEOUT",errorCode:"VERCEL_TIMEOUT",userMessage:"Deployment provider did not respond in time. Retrying automatically.",retryableNow:true};
  const code=error?.safeBody?.error?.code ?? error?.safeBody?.code ?? null; const message=error?.safeBody?.error?.message ?? error?.safeBody?.message ?? null;
  if(error?.status===402&&code==="payment_required"&&/api-deployments-free-per-day/i.test(String(message)))return{classification:"BLOCKED_EXTERNAL_QUOTA",errorCode:"VERCEL_DAILY_DEPLOYMENT_QUOTA",userMessage:"Deployment provider daily limit reached. Retry after the provider quota resets.",retryableNow:false};
  if(error?.status===429)return{classification:"PROVIDER_RATE_LIMITED",errorCode:"VERCEL_RATE_LIMIT",userMessage:"Deployment provider is rate limiting requests. Retry later.",retryableNow:true};
  if(error?.status===401||error?.status===403)return{classification:"PROVIDER_AUTH_ERROR",errorCode:"VERCEL_AUTH",userMessage:"Deployment provider credentials or permissions need attention.",retryableNow:false};
  return null;
}

async function listCandidateDeployments(projectId: string) {
  const body = await vercelRequest(`/v7/deployments${teamQuery({ projectId, target: "production", limit: "50" })}`);
  const deployments = Array.isArray(body?.deployments) ? body.deployments : [];
  const detailed = [];
  for (const item of deployments) {
    const id = item?.uid ?? item?.id;
    if (!id) continue;
    detailed.push(await vercelRequest(`/v13/deployments/${encodeURIComponent(id)}${teamQuery()}`));
  }
  return detailed;
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

async function enforceGitAutoDeployments(project: any) {
  const result = await ensureGitAutoDeploymentsDisabled({
    project,
    projectId: project?.id,
    trustedVercelProjectResponse: true,
    getProject: getVercelProject,
    updateProject: updateVercelProject,
  });
  if (!result.ok) throw new Error(`Vercel Git auto-deploy containment failed: ${result.result}`);
  return result;
}

async function ensureBuildOperation(db: pg.Client, deployment: any) {
  const idempotencyKey = sscBuildOperationKey({ deploymentId: deployment.id, sourceCommitSha: deployment.commit_sha });
  const result = await ensureBuildOperationWithinWorkspaceLimit(db, { ...deployment, idempotency_key: idempotencyKey });
  return result;
}

async function attachProviderDeployment(db: pg.Client, deployment: any, providerDeployment: any, operationId: string, eventType: string) {
  const providerDeploymentId = providerDeployment?.id ?? providerDeployment?.uid;
  if (!providerDeploymentId) throw new Error("Provider deployment has no id");
  assertSscProviderResourceIdentity(providerDeployment, {
    id: deployment.id,
    source_commit_sha: deployment.commit_sha,
  });
  const deploymentUrl = providerDeploymentUrl(providerDeployment);
  const providerStatus = providerDeployment?.readyState ?? providerDeployment?.status ?? "QUEUED";

  await db.query("BEGIN");
  try {
    const current = await db.query(
      `SELECT d.status AS deployment_status,
              o.status AS operation_status
         FROM deployments d
         JOIN deployment_provider_operations o ON o.id=$1
        WHERE d.id=$2
        FOR UPDATE OF d,o`,
      [operationId, deployment.id],
    );
    if (current.rowCount !== 1) throw new Error("Deployment/provider operation disappeared before build attachment");
    const decision = buildResultAttachmentDecision(current.rows[0]);
    if (decision.action !== "attach") {
      await db.query(
        `UPDATE deployment_provider_operations
            SET provider_resource_id=$1,
                status='OBSERVED_STALE',
                updated_at=now(),
                metadata=metadata||$2::jsonb
          WHERE id=$3`,
        [providerDeploymentId, JSON.stringify({
          staleReason: decision.reason,
          providerDeploymentUrl: deploymentUrl,
          providerStatus,
          sourceCommitSha: deployment.commit_sha,
        }), operationId],
      );
      await db.query(
        `INSERT INTO deployment_events
           (deployment_id,from_status,to_status,event_type,message,metadata)
         VALUES ($1,$2,$2,'BUILD_PROVIDER_RESULT_STALE',
                 'Provider deployment result was observed after deployment became incompatible', $3::jsonb)`,
        [deployment.id, current.rows[0].deployment_status, JSON.stringify({
          provider: "vercel",
          providerDeploymentId,
          providerDeploymentUrl: deploymentUrl,
          providerStatus,
          staleReason: decision.reason,
          providerOperationId: operationId,
          providerResourceTraceable: true,
        })],
      );
      await db.query("COMMIT");
      return { providerDeploymentId, providerDeploymentUrl: deploymentUrl, providerStatus, stale: true, staleReason: decision.reason };
    }
    await db.query(
      `INSERT INTO deployment_builds
         (deployment_id, provider, provider_deployment_id, provider_deployment_url, source_commit_sha, status)
       VALUES ($1,'vercel',$2,$3,$4,$5)
       ON CONFLICT (deployment_id) DO UPDATE SET
         provider_deployment_id = EXCLUDED.provider_deployment_id,
         provider_deployment_url = COALESCE(EXCLUDED.provider_deployment_url, deployment_builds.provider_deployment_url),
         status = EXCLUDED.status,
         updated_at = now()`,
      [deployment.id, providerDeploymentId, deploymentUrl, deployment.commit_sha, providerStatus],
    );
    await db.query(
      `UPDATE deployments
          SET provider_deployment_id=$1,error_code=NULL,error_message=NULL,updated_at=now()
        WHERE id=$2 AND status='BUILDING'`,
      [providerDeploymentId, deployment.id],
    );
    await db.query(
      `UPDATE deployment_provider_operations
          SET provider_resource_id=$1,status='OBSERVED',updated_at=now()
        WHERE id=$2`,
      [providerDeploymentId, operationId],
    );
    await db.query(
      `INSERT INTO deployment_events
         (deployment_id,from_status,to_status,event_type,message,metadata)
       VALUES ($1,'BUILDING','BUILDING',$2,'Immutable production provider build attached',$3::jsonb)`,
      [deployment.id, eventType, JSON.stringify({
        provider: "vercel",
        providerDeploymentId,
        providerDeploymentUrl: deploymentUrl,
        sourceCommitSha: deployment.commit_sha,
        manifestSha256: deployment.manifest_sha256,
        providerStatus,
        target: "production",
        providerOperationId: operationId,
      })],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }

  return { providerDeploymentId, providerDeploymentUrl: deploymentUrl, providerStatus };
}

export const executeBuild=task({id:"ssc-control-plane-execute-build",retry:{maxAttempts:3,minTimeoutInMs:2000,maxTimeoutInMs:10000,factor:2,randomize:false},run:async(payload:{deploymentId:string})=>{
 if(!process.env.DATABASE_URL)throw new Error("Missing DATABASE_URL");const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
 try{
  return await runExecuteBuild(db,payload);
 }finally{await db.end()}
}});

// Everything this task does beyond its two initial lookups used to have no
// error handling at all: only the one catch block around the final
// deployment-creation call ever wrote a deployment_events row. A real
// customer deployment ("math-game") got stuck silently — twice — with
// nothing in our own event log to show why, because whichever earlier
// Vercel call (getVercelProject, enforceGitAutoDeployments,
// listCandidateDeployments — none of which had error handling) actually
// failed left no trace here at all, visible only on Trigger.dev's own
// dashboard as a failed task run. This wrapper doesn't change what the
// task does or its retry semantics — Trigger.dev's own task-level retry
// (see the task() options above) still applies exactly as before, since
// this rethrows — it just guarantees SOME diagnosable event lands in our
// own database on any failure here, not only the one specific call site
// that happened to have a catch block already.
async function runExecuteBuild(db:any,payload:{deploymentId:string}){
 try{
  const existing=await db.query(`SELECT provider,provider_deployment_id,provider_deployment_url,source_commit_sha,status FROM deployment_builds WHERE deployment_id=$1`,[payload.deploymentId]);
  if(existing.rowCount===1){const build=existing.rows[0];return{result:"NODE_04_10_REPLAY_NOOP",deploymentId:payload.deploymentId,provider:build.provider,providerDeploymentId:build.provider_deployment_id,providerDeploymentUrl:build.provider_deployment_url,sourceCommitSha:build.source_commit_sha,buildStatus:build.status}}
  const result=await db.query(`SELECT d.id,d.workspace_id,d.app_id,d.status,d.runtime_project_id,a.slug,a.framework,rt.provider,rt.provider_project_id,rt.provider_project_name,bi.repository_full_name,bi.commit_sha,bi.root_directory,bi.install_command,bi.build_command,bi.manifest_sha256,bi.manifest->>'framework' AS build_input_framework FROM deployments d JOIN apps a ON a.id=d.app_id JOIN app_runtimes rt ON rt.app_id=d.app_id JOIN deployment_build_inputs bi ON bi.deployment_id=d.id WHERE d.id=$1`,[payload.deploymentId]);
  if(result.rowCount===0)throw new Error(`Build prerequisites not found: ${payload.deploymentId}`);const deployment=result.rows[0];
  if(deployment.status!=="BUILDING")throw new Error(`Build can only execute from BUILDING; current status is ${deployment.status}`);if(deployment.provider!=="vercel")throw new Error(`Unsupported build provider: ${deployment.provider}`);if(deployment.runtime_project_id!==deployment.provider_project_id)throw new Error("Runtime project binding mismatch");
  assertRuntimeMatchesDeployment({workspace_id:deployment.workspace_id,app_id:deployment.app_id,provider_project_id:deployment.provider_project_id},deployment);
  const localOwners=await db.query(`SELECT app_id,provider_project_id FROM app_runtimes WHERE provider=$1 AND provider_project_id=$2`,[deployment.provider,deployment.provider_project_id]);
  assertProviderProjectNotOwnedByAnotherApp(localOwners.rows,{appId:deployment.app_id,providerProjectId:deployment.provider_project_id});
  const remoteProject=await getVercelProject(deployment.provider_project_id);
  assertRemoteProjectMatchesSscApp(remoteProject,{workspaceId:deployment.workspace_id,appId:deployment.app_id,slug:deployment.slug,storedProjectName:deployment.provider_project_name,allowLegacyStoredBinding:true});
  await enforceGitAutoDeployments(remoteProject);
  const operationResult=await ensureBuildOperation(db,deployment);
  if(operationResult.allowed!==true){
    return{result:"NODE_15R_11_PROVIDER_OPERATION_LIMIT_REACHED",deploymentId:payload.deploymentId,status:"BUILDING",createdNewDeployment:false,errorCode:operationResult.decision.code,message:operationResult.decision.message,observed:operationResult.decision.observed,limit:operationResult.decision.limit};
  }
  const operation=operationResult.operation;
  assertProviderOperationBelongsToDeployment(operation,{id:deployment.id,source_commit_sha:deployment.commit_sha});

  const matches=matchingSscDeployments(await listCandidateDeployments(deployment.provider_project_id),{deploymentId:deployment.id,sourceCommitSha:deployment.commit_sha});
  const action=buildRecoveryAction({matches,operationStatus:operation.status});
  if(action.action==="ambiguous"){
    await db.query(`UPDATE deployment_provider_operations SET status='AMBIGUOUS',updated_at=now(),metadata=metadata||$1::jsonb WHERE id=$2`,[JSON.stringify({matchingDeploymentCount:action.count}),operation.id]);
    return{result:"NODE_04_18_BUILD_RECOVERY_AMBIGUOUS",deploymentId:payload.deploymentId,status:"BUILDING",matchingDeploymentCount:action.count,createdNewDeployment:false};
  }
  if(action.action==="attach"){
    const attached=await attachProviderDeployment(db,deployment,action.deployment,operation.id,"BUILD_RECOVERY_ATTACHED");
    return{result:"NODE_04_18_BUILD_RECOVERY_ATTACHED",deploymentId:payload.deploymentId,provider:"vercel",providerProjectId:deployment.provider_project_id,...attached,sourceCommitSha:deployment.commit_sha,manifestSha256:deployment.manifest_sha256,target:"production",createdNewDeployment:false};
  }
  if(action.action==="pending"){
    return{result:"NODE_04_18_BUILD_RECOVERY_PENDING",deploymentId:payload.deploymentId,status:"BUILDING",providerProjectId:deployment.provider_project_id,sourceCommitSha:deployment.commit_sha,createdNewDeployment:false};
  }

  const [org,repo]=String(deployment.repository_full_name).split("/");if(!org||!repo)throw new Error(`Invalid GitHub repository identity: ${deployment.repository_full_name}`);
  if(providerCreateClaimDecision(operation).action!=="claim-create"){
    return{result:"NODE_15R_4_BUILD_CREATE_NOT_CLAIMED",deploymentId:payload.deploymentId,status:"BUILDING",providerProjectId:deployment.provider_project_id,sourceCommitSha:deployment.commit_sha,createdNewDeployment:false,operationStatus:operation.status};
  }
  const claim=await claimProviderCreateOperation(db,{operationId:operation.id});
  if(!claim.claimed){
    return{result:"NODE_15R_4_BUILD_CREATE_ALREADY_CLAIMED",deploymentId:payload.deploymentId,status:"BUILDING",providerProjectId:deployment.provider_project_id,sourceCommitSha:deployment.commit_sha,createdNewDeployment:false,operationStatus:claim.operation.status};
  }
  const resolvedFramework=deployment.build_input_framework||deployment.framework||"nextjs";
  const body:any={name:deployment.provider_project_name,project:deployment.provider_project_id,target:"production",gitSource:{type:"github",org,repo,ref:deployment.commit_sha},meta:sscDeploymentMeta({deploymentId:payload.deploymentId,sourceCommitSha:deployment.commit_sha,manifestSha256:deployment.manifest_sha256}),projectSettings:{framework:toVercelFrameworkValue(resolvedFramework),installCommand:deployment.install_command,buildCommand:deployment.build_command}};
  // Retries transparently, silently, when the failure is classified as
  // retryableNow (currently just Vercel rate limiting) — so a rate-limit
  // blip that clears within a few seconds never becomes a customer-visible
  // failure at all. Any non-retryable or still-failing-after-retries error
  // falls through to the exact same catch block as before, unchanged.
  let created:any;try{created=await withTransientRetry(()=>vercelRequest(`/v13/deployments${teamQuery()}`,{method:"POST",body:JSON.stringify(body)}),{maxAttempts:3,baseDelayMs:1000,maxDelayMs:8000,isRetryable:(error:any)=>classifyProviderError(error)?.retryableNow===true})}catch(error:any){const classifiedError=classifyProviderError(error);if(!classifiedError)throw error;await db.query(`UPDATE deployments SET error_code=$1,error_message=$2,updated_at=now() WHERE id=$3`,[classifiedError.errorCode,classifiedError.userMessage,payload.deploymentId]);await db.query(`UPDATE deployment_provider_operations SET status='FAILED',updated_at=now(),metadata=metadata||$1::jsonb WHERE id=$2`,[JSON.stringify({classification:classifiedError.classification,errorCode:classifiedError.errorCode}),operation.id]);await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'BUILDING','BUILDING','BUILD_PROVIDER_BLOCKED',$2,$3::jsonb)`,[payload.deploymentId,classifiedError.userMessage,JSON.stringify({provider:"vercel",classification:classifiedError.classification,errorCode:classifiedError.errorCode,retryableNow:classifiedError.retryableNow,providerOperationId:operation.id})]);return{result:`NODE_04_10_${classifiedError.classification}`,deploymentId:payload.deploymentId,provider:"vercel",sourceCommitSha:deployment.commit_sha,deploymentStatus:deployment.status,errorCode:classifiedError.errorCode,message:classifiedError.userMessage,retryableNow:classifiedError.retryableNow}}
  const attached=await attachProviderDeployment(db,deployment,created,operation.id,"BUILD_STARTED");
  if(attached.stale){
    return{result:"NODE_15R_4_BUILD_PROVIDER_RESULT_STALE",deploymentId:payload.deploymentId,provider:"vercel",providerProjectId:deployment.provider_project_id,...attached,sourceCommitSha:deployment.commit_sha,manifestSha256:deployment.manifest_sha256,target:"production",createdNewDeployment:true,providerResourceTraceable:true};
  }
  return{result:"NODE_04_10_BUILD_STARTED",deploymentId:payload.deploymentId,provider:"vercel",providerProjectId:deployment.provider_project_id,...attached,sourceCommitSha:deployment.commit_sha,manifestSha256:deployment.manifest_sha256,target:"production",createdNewDeployment:true};
 }catch(error:any){
  // Records SOME diagnosable trace of any failure this task hits before
  // reaching its one specific, already-handled catch block above — not a
  // replacement for that block's precise classification, just a floor so
  // "the task failed and nothing shows why" can't happen again. Best-effort:
  // if even this insert fails, the original error still propagates, since
  // that's strictly more informative than a swallowed logging failure.
  await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'BUILDING','BUILDING','BUILD_EXECUTION_ERROR',$2,$3::jsonb)`,[payload.deploymentId,"Build execution hit an unexpected error.",JSON.stringify({errorMessage:String(error?.message??error),errorName:error?.name??null})]).catch(()=>{});
  // Also releases any operation this run claimed (CREATE_REQUESTED) back
  // to FAILED, so the next resume attempt can reclaim and retry it. Found
  // needed the hard way: an unclassified error (classifyProviderError
  // returns null for anything outside its specific known cases — a plain
  // Vercel 400, for instance) skips the one specific catch block that
  // normally does this reset, since it rethrows before reaching that
  // block's own cleanup. Without this, ANY error outside that narrow
  // known set leaves the operation permanently stuck exactly like the
  // original timeout bug did, just via a different code path — an
  // operator would need to manually reset it again for every new kind of
  // unclassified failure, not just this one already-fixed instance.
  await db.query(`UPDATE deployment_provider_operations SET status='FAILED',updated_at=now() WHERE deployment_id=$1 AND status='CREATE_REQUESTED' AND provider_resource_id IS NULL`,[payload.deploymentId]).catch(()=>{});
  throw error;
 }
}
