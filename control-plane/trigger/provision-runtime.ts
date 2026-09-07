import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  ensureGitAutoDeploymentsDisabled,
  sscManagedProjectGitSettings,
} from "../src/vercel-project-config.mjs";
import { runtimeRecoveryAction } from "../src/vercel-runtime-recovery.mjs";
import { vercelRootDirectory } from "../src/source-boundary.mjs";
import {
  assertProviderProjectNotOwnedByAnotherApp,
  assertRemoteProjectMatchesSscApp,
  sscProviderProjectName,
} from "../src/provider-project-identity.mjs";
import { assertRuntimeMatchesDeployment } from "../src/tenant-boundary.mjs";
import { runtimeResultAttachmentDecision } from "../src/provider-mutation-fencing.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}
function teamQuery() { const teamId=process.env.VERCEL_TEAM_ID; return teamId?`?teamId=${encodeURIComponent(teamId)}`:""; }
function safeProviderErrorBody(body:any){ if(!body||typeof body!=="object")return body; const error=body.error&&typeof body.error==="object"?body.error:null; return {error:error?{code:error.code??null,message:error.message??null}:null,code:body.code??null,message:body.message??null}; }
async function request(path:string,options:RequestInit={}){ const token=process.env.VERCEL_TOKEN; if(!token)throw new Error("Missing VERCEL_TOKEN"); const response=await fetch(`${API}${path}`,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...(options.headers??{})}}); const text=await response.text(); let body:any=null; if(text){try{body=JSON.parse(text)}catch{body=text}} if(!response.ok){const safeBody=safeProviderErrorBody(body);const details=safeBody?`: ${JSON.stringify(safeBody)}`:"";const error:any=new Error(`Vercel API ${response.status} ${response.statusText}${details}`);error.status=response.status;throw error;} return body; }
async function getRuntime(name:string){try{return await request(`/v9/projects/${encodeURIComponent(name)}${teamQuery()}`)}catch(error:any){if(error.status===404)return null;throw error}}
async function enforceRuntimeGitAutoDeployments(project:any){const result=await ensureGitAutoDeploymentsDisabled({project,projectId:project?.id});if(!result.ok)throw new Error(`Vercel Git auto-deploy containment failed: ${result.result}`);return result}
async function ensureRuntime({name,rootDirectory,workspaceId,appId,slug}:{name:string;repository:string;rootDirectory:string;workspaceId:string;appId:string;slug:string}){const existing=await getRuntime(name);const action=runtimeRecoveryAction({localRuntime:null,remoteProject:existing});if(action.action==="reconcile-remote-project"){assertRemoteProjectMatchesSscApp(existing,{workspaceId,appId,slug});const gitAutoDeploy=await enforceRuntimeGitAutoDeployments(existing);return{resource:existing,created:false,reconciled:true,gitAutoDeploy};}const normalizedRootDirectory=vercelRootDirectory(rootDirectory);try{const created=await request(`/v11/projects${teamQuery()}`,{method:"POST",body:JSON.stringify({name,framework:"nextjs",...(normalizedRootDirectory?{rootDirectory:normalizedRootDirectory}:{}),...sscManagedProjectGitSettings()})});assertRemoteProjectMatchesSscApp(created,{workspaceId,appId,slug});const gitAutoDeploy=await enforceRuntimeGitAutoDeployments(created);return{resource:created,created:true,reconciled:false,gitAutoDeploy}}catch(error:any){if([400,409].includes(error.status)){const reconciled=await getRuntime(name);if(reconciled){assertRemoteProjectMatchesSscApp(reconciled,{workspaceId,appId,slug});const gitAutoDeploy=await enforceRuntimeGitAutoDeployments(reconciled);return{resource:reconciled,created:false,reconciled:true,gitAutoDeploy}}}throw error}}

export const provisionRuntime=task({
 id:"ssc-control-plane-provision-runtime", retry:{maxAttempts:3,minTimeoutInMs:2000,maxTimeoutInMs:10000,factor:2,randomize:false},
 run:async(payload:{deploymentId:string})=>withDb(async(db)=>{
  const result=await db.query(`SELECT d.id,d.workspace_id,d.app_id,d.status,a.slug,a.root_directory,r.full_name AS repository_full_name FROM deployments d JOIN apps a ON a.id=d.app_id JOIN github_repositories r ON r.id=a.repository_id WHERE d.id=$1`,[payload.deploymentId]);
  if(result.rowCount===0)throw new Error(`Deployment not found: ${payload.deploymentId}`);const deployment=result.rows[0];
  if(!["PROVISIONING","BUILDING"].includes(deployment.status))throw new Error(`Runtime cannot be provisioned from status ${deployment.status}`);
  const existingRuntime=await db.query(`SELECT workspace_id,app_id,provider,provider_project_id,provider_project_name,reconciliation_key,status FROM app_runtimes WHERE app_id=$1`,[deployment.app_id]);
  if(existingRuntime.rowCount===1){
   const runtime=existingRuntime.rows[0];
   assertRuntimeMatchesDeployment(runtime,deployment);
   const localOwners=await db.query(`SELECT app_id,provider_project_id FROM app_runtimes WHERE provider=$1 AND provider_project_id=$2`,[runtime.provider,runtime.provider_project_id]);
   assertProviderProjectNotOwnedByAnotherApp(localOwners.rows,{appId:deployment.app_id,providerProjectId:runtime.provider_project_id});
   const remoteProject=await getRuntime(runtime.provider_project_id);if(!remoteProject)throw new Error("Stored Vercel runtime project no longer exists");
   assertRemoteProjectMatchesSscApp(remoteProject,{workspaceId:deployment.workspace_id,appId:deployment.app_id,slug:deployment.slug,storedProjectName:runtime.provider_project_name,allowLegacyStoredBinding:true});
   const gitAutoDeploy=await enforceRuntimeGitAutoDeployments(remoteProject);
   if(deployment.status==="PROVISIONING"){
    await db.query("BEGIN");try{
     const current=await db.query(`SELECT d.status AS deployment_status,a.deleted_at AS app_deleted_at FROM deployments d JOIN apps a ON a.id=d.app_id WHERE d.id=$1 FOR UPDATE OF d,a`,[payload.deploymentId]);
     if(current.rowCount!==1)throw new Error(`Deployment disappeared before runtime reconciliation: ${payload.deploymentId}`);
     const decision=runtimeResultAttachmentDecision(current.rows[0]);
     if(decision.action!=="attach"){
      await db.query("COMMIT");
      return{result:"NODE_15R_4_RUNTIME_RECONCILE_STALE_NOOP",deploymentId:payload.deploymentId,status:current.rows[0].deployment_status,provider:runtime.provider,providerProjectId:runtime.provider_project_id,providerProjectName:runtime.provider_project_name,reconciliationKey:runtime.reconciliation_key,runtimeStatus:runtime.status,staleReason:decision.reason};
     }
     const advanced=await db.query(`UPDATE deployments SET runtime_project_id=$1,status='BUILDING',updated_at=now() WHERE id=$2 AND status='PROVISIONING' RETURNING id`,[runtime.provider_project_id,payload.deploymentId]);
     if(advanced.rowCount===1)await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'PROVISIONING','BUILDING','RUNTIME_RECONCILED','Existing application runtime reconciled for deployment',$2::jsonb)`,[payload.deploymentId,JSON.stringify({provider:runtime.provider,providerProjectId:runtime.provider_project_id,reconciliationKey:runtime.reconciliation_key,gitAutoDeploy})]);
     await db.query("COMMIT");
    }catch(error){await db.query("ROLLBACK");throw error}
   }
   return{result:"NODE_04_8_RUNTIME_RECONCILED",deploymentId:payload.deploymentId,status:"BUILDING",provider:runtime.provider,providerProjectId:runtime.provider_project_id,providerProjectName:runtime.provider_project_name,reconciliationKey:runtime.reconciliation_key,runtimeStatus:runtime.status,gitAutoDeploy};
  }
  const projectName=sscProviderProjectName({workspaceId:deployment.workspace_id,appId:deployment.app_id,slug:deployment.slug});const reconciliationKey=`runtime:${deployment.workspace_id}:${deployment.app_id}`;
  const provisioned=await ensureRuntime({name:projectName,repository:deployment.repository_full_name,rootDirectory:deployment.root_directory,workspaceId:deployment.workspace_id,appId:deployment.app_id,slug:deployment.slug});const project=provisioned.resource;if(!project?.id)throw new Error("Vercel runtime creation returned no project id");
  const localOwners=await db.query(`SELECT app_id,provider_project_id FROM app_runtimes WHERE provider='vercel' AND provider_project_id=$1`,[project.id]);
  assertProviderProjectNotOwnedByAnotherApp(localOwners.rows,{appId:deployment.app_id,providerProjectId:project.id});
  await db.query("BEGIN");try{
   const current=await db.query(`SELECT d.status AS deployment_status,a.deleted_at AS app_deleted_at FROM deployments d JOIN apps a ON a.id=d.app_id WHERE d.id=$1 FOR UPDATE OF d,a`,[payload.deploymentId]);
   if(current.rowCount!==1)throw new Error(`Deployment disappeared before runtime attachment: ${payload.deploymentId}`);
   const decision=runtimeResultAttachmentDecision(current.rows[0]);
   if(decision.action!=="attach"){
    await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'RUNTIME_PROVIDER_RESULT_STALE','Provider runtime result was observed after app/deployment became incompatible',$3::jsonb)`,[payload.deploymentId,current.rows[0].deployment_status,JSON.stringify({provider:"vercel",providerProjectId:project.id,providerProjectName:project.name??projectName,reconciliationKey,staleReason:decision.reason,providerResourceTraceable:true})]);
    await db.query("COMMIT");
    return{result:"NODE_15R_4_RUNTIME_PROVIDER_RESULT_STALE",deploymentId:payload.deploymentId,status:current.rows[0].deployment_status,provider:"vercel",providerProjectId:project.id,providerProjectName:project.name??projectName,reconciliationKey,created:provisioned.created,reconciled:provisioned.reconciled,providerResourceTraceable:true,staleReason:decision.reason};
   }
   await db.query(`INSERT INTO app_runtimes (workspace_id,app_id,provider,provider_project_id,provider_project_name,reconciliation_key,status) VALUES ($1,$2,'vercel',$3,$4,$5,'READY')`,[deployment.workspace_id,deployment.app_id,project.id,project.name??projectName,reconciliationKey]);
   await db.query(`UPDATE deployments SET runtime_project_id=$1,status='BUILDING',updated_at=now() WHERE id=$2 AND status='PROVISIONING'`,[project.id,payload.deploymentId]);
   await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'PROVISIONING','BUILDING','RUNTIME_PROVISIONED','Application runtime provisioned or reconciled',$2::jsonb)`,[payload.deploymentId,JSON.stringify({provider:"vercel",providerProjectId:project.id,providerProjectName:project.name??projectName,reconciliationKey,created:provisioned.created,reconciled:provisioned.reconciled,skipGitConnectDuringLink:true,gitAutoDeploy:provisioned.gitAutoDeploy})]);await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error}
  return{result:"NODE_04_8_RUNTIME_PROVISIONED",deploymentId:payload.deploymentId,status:"BUILDING",provider:"vercel",providerProjectId:project.id,providerProjectName:project.name??projectName,reconciliationKey,created:provisioned.created,reconciled:provisioned.reconciled,skipGitConnectDuringLink:true,gitAutoDeploy:provisioned.gitAutoDeploy};
 })
});
