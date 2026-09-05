import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  buildRecoveryAction,
  matchingSscDeployments,
  providerDeploymentUrl,
  sscBuildOperationKey,
  sscDeploymentMeta,
} from "../src/vercel-deployment-recovery.mjs";
import {
  assertProviderProjectNotOwnedByAnotherApp,
  assertRemoteProjectMatchesSscApp,
} from "../src/provider-project-identity.mjs";
import {
  assertProviderOperationBelongsToDeployment,
  assertRuntimeMatchesDeployment,
  assertSscProviderResourceIdentity,
} from "../src/tenant-boundary.mjs";

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

async function vercelRequest(path: string, options: RequestInit = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const text = await response.text(); let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) { const safe = safeProviderErrorBody(body); const error: any = new Error(`Vercel API ${response.status} ${response.statusText}${safe ? `: ${JSON.stringify(safe)}` : ""}`); error.status=response.status; error.safeBody=safe; throw error; }
  return body;
}

function classifyProviderError(error: any) {
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

async function ensureBuildOperation(db: pg.Client, deployment: any) {
  const idempotencyKey = sscBuildOperationKey({ deploymentId: deployment.id, sourceCommitSha: deployment.commit_sha });
  const result = await db.query(
    `INSERT INTO deployment_provider_operations
       (deployment_id, operation_type, provider, idempotency_key, source_commit_sha,
        provider_project_id, status, metadata)
     VALUES ($1,'vercel-create-deployment','vercel',$2,$3,$4,'INTENT_RECORDED',$5::jsonb)
     ON CONFLICT (deployment_id, operation_type) DO UPDATE SET
       updated_at = deployment_provider_operations.updated_at
     RETURNING id, deployment_id, status, provider_resource_id, source_commit_sha`,
    [
      deployment.id,
      idempotencyKey,
      deployment.commit_sha,
      deployment.provider_project_id,
      JSON.stringify({ target: "production", providerProjectId: deployment.provider_project_id }),
    ],
  );
  return result.rows[0];
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
  const existing=await db.query(`SELECT provider,provider_deployment_id,provider_deployment_url,source_commit_sha,status FROM deployment_builds WHERE deployment_id=$1`,[payload.deploymentId]);
  if(existing.rowCount===1){const build=existing.rows[0];return{result:"NODE_04_10_REPLAY_NOOP",deploymentId:payload.deploymentId,provider:build.provider,providerDeploymentId:build.provider_deployment_id,providerDeploymentUrl:build.provider_deployment_url,sourceCommitSha:build.source_commit_sha,buildStatus:build.status}}
  const result=await db.query(`SELECT d.id,d.workspace_id,d.app_id,d.status,d.runtime_project_id,a.slug,a.framework,rt.provider,rt.provider_project_id,rt.provider_project_name,bi.repository_full_name,bi.commit_sha,bi.root_directory,bi.install_command,bi.build_command,bi.manifest_sha256 FROM deployments d JOIN apps a ON a.id=d.app_id JOIN app_runtimes rt ON rt.app_id=d.app_id JOIN deployment_build_inputs bi ON bi.deployment_id=d.id WHERE d.id=$1`,[payload.deploymentId]);
  if(result.rowCount===0)throw new Error(`Build prerequisites not found: ${payload.deploymentId}`);const deployment=result.rows[0];
  if(deployment.status!=="BUILDING")throw new Error(`Build can only execute from BUILDING; current status is ${deployment.status}`);if(deployment.provider!=="vercel")throw new Error(`Unsupported build provider: ${deployment.provider}`);if(deployment.runtime_project_id!==deployment.provider_project_id)throw new Error("Runtime project binding mismatch");
  assertRuntimeMatchesDeployment({workspace_id:deployment.workspace_id,app_id:deployment.app_id,provider_project_id:deployment.provider_project_id},deployment);
  const localOwners=await db.query(`SELECT app_id,provider_project_id FROM app_runtimes WHERE provider=$1 AND provider_project_id=$2`,[deployment.provider,deployment.provider_project_id]);
  assertProviderProjectNotOwnedByAnotherApp(localOwners.rows,{appId:deployment.app_id,providerProjectId:deployment.provider_project_id});
  assertRemoteProjectMatchesSscApp(await getVercelProject(deployment.provider_project_id),{workspaceId:deployment.workspace_id,appId:deployment.app_id,slug:deployment.slug,storedProjectName:deployment.provider_project_name,allowLegacyStoredBinding:true});
  const operation=await ensureBuildOperation(db,deployment);
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
  await db.query(`UPDATE deployment_provider_operations SET status='CREATE_REQUESTED',updated_at=now() WHERE id=$1`,[operation.id]);
  const body:any={name:deployment.provider_project_name,project:deployment.provider_project_id,target:"production",gitSource:{type:"github",org,repo,ref:deployment.commit_sha},meta:sscDeploymentMeta({deploymentId:payload.deploymentId,sourceCommitSha:deployment.commit_sha,manifestSha256:deployment.manifest_sha256}),projectSettings:{framework:deployment.framework||"nextjs",installCommand:deployment.install_command,buildCommand:deployment.build_command}};
  let created:any;try{created=await vercelRequest(`/v13/deployments${teamQuery()}`,{method:"POST",body:JSON.stringify(body)})}catch(error:any){const classifiedError=classifyProviderError(error);if(!classifiedError)throw error;await db.query(`UPDATE deployments SET error_code=$1,error_message=$2,updated_at=now() WHERE id=$3`,[classifiedError.errorCode,classifiedError.userMessage,payload.deploymentId]);await db.query(`UPDATE deployment_provider_operations SET status='FAILED',updated_at=now(),metadata=metadata||$1::jsonb WHERE id=$2`,[JSON.stringify({classification:classifiedError.classification,errorCode:classifiedError.errorCode}),operation.id]);await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'BUILDING','BUILDING','BUILD_PROVIDER_BLOCKED',$2,$3::jsonb)`,[payload.deploymentId,classifiedError.userMessage,JSON.stringify({provider:"vercel",classification:classifiedError.classification,errorCode:classifiedError.errorCode,retryableNow:classifiedError.retryableNow,providerOperationId:operation.id})]);return{result:`NODE_04_10_${classifiedError.classification}`,deploymentId:payload.deploymentId,provider:"vercel",sourceCommitSha:deployment.commit_sha,deploymentStatus:deployment.status,errorCode:classifiedError.errorCode,message:classifiedError.userMessage,retryableNow:classifiedError.retryableNow}}
  const attached=await attachProviderDeployment(db,deployment,created,operation.id,"BUILD_STARTED");
  return{result:"NODE_04_10_BUILD_STARTED",deploymentId:payload.deploymentId,provider:"vercel",providerProjectId:deployment.provider_project_id,...attached,sourceCommitSha:deployment.commit_sha,manifestSha256:deployment.manifest_sha256,target:"production",createdNewDeployment:true};
 }finally{await db.end()}
}});
