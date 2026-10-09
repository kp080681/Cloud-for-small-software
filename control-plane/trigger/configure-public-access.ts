import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { publicAccessRecoveryAction } from "../src/deployment-recovery-rules.mjs";
import { assertSafeWorkloadRedirect, assertSafeWorkloadUrl, publicAccessRequestInit } from "../src/workload-http.mjs";
import { sanitizedProjectSlug } from "../src/provider-project-identity.mjs";
import {
  ProviderDeploymentIdentityStatus,
  PublicBindingStatus,
  SourceIdentityStatus,
  verifyProviderDeploymentIdentity,
  verifyProviderSourceIdentity,
  verifyPublicBinding,
  publicBindingHostCandidates,
} from "../src/vercel-deployment-identity.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function teamQuery(extra:Record<string,string>={}){const query=new URLSearchParams(extra);const teamId=process.env.VERCEL_TEAM_ID;if(teamId)query.set("teamId",teamId);const text=query.toString();return text?`?${text}`:""}
// 25s bound on every Vercel API call — same fix as provision-runtime.ts and
// apply-runtime-env.ts: an unbounded fetch here can hang forever instead of
// throwing, stranding a deployment at HEALTH_CHECKING with no error.
const VERCEL_REQUEST_TIMEOUT_MS=25_000;
async function vercelRequest(path:string,options:RequestInit={}){if(!process.env.VERCEL_TOKEN)throw new Error("Missing VERCEL_TOKEN");const controller=new AbortController();const timeoutHandle=setTimeout(()=>controller.abort(),VERCEL_REQUEST_TIMEOUT_MS);let response:Response;try{response=await fetch(`${API}${path}`,{...options,headers:{Authorization:`Bearer ${process.env.VERCEL_TOKEN}`,"Content-Type":"application/json",...(options.headers??{})},signal:controller.signal})}catch(error:any){if(error?.name==="AbortError"){const timeoutError:any=new Error(`Vercel API request timed out after ${VERCEL_REQUEST_TIMEOUT_MS}ms: ${path}`);timeoutError.isTimeout=true;throw timeoutError}throw error}finally{clearTimeout(timeoutHandle)}const text=await response.text();let body:any=null;if(text){try{body=JSON.parse(text)}catch{body=null}}if(!response.ok){const error:any=new Error(`Vercel API ${response.status} ${response.statusText}`);error.status=response.status;throw error}return body}
async function vercelRequestOptional(path:string){try{return await vercelRequest(path)}catch(error:any){if(error?.status===404)return null;throw error}}
function isVercelAuthRedirect(location:string|null){if(!location)return false;try{const u=new URL(location);return u.hostname==="vercel.com"||u.hostname.endsWith(".vercel.com")}catch{return /vercel\.com/i.test(location)}}
async function anonymousCheck(url:string){assertSafeWorkloadUrl(url);const started=Date.now();const response=await fetch(url,publicAccessRequestInit({signal:AbortSignal.timeout(8000),userAgent:BROWSER_UA}));const latencyMs=Date.now()-started;const location=response.headers.get("location");let redirectUnsafe=false;if(location){try{assertSafeWorkloadRedirect(location,url)}catch{redirectUnsafe=true}}const vercelAuthRedirect=isVercelAuthRedirect(location);const publiclyReachable=!redirectUnsafe&&!vercelAuthRedirect&&response.status>=200&&response.status<400;try{await response.body?.cancel()}catch{}return{httpStatus:response.status,latencyMs,location,vercelAuthRedirect,redirectUnsafe,publiclyReachable}}

// Node: branded subdomain overlay. Every production deployment already gets
// a verified, publicly-reachable provider URL (the checks above) — this is
// purely additive on top of that, never a substitute for it: it puts the
// Utplava brand into the URL every lead actually sees, without touching the
// tenant-identity-bearing Vercel project name at all (renaming THAT would
// break assertRemoteProjectMatchesSscApp for every already-live app on its
// next redeploy — see provider-project-identity.mjs). Requires utplava.dev's
// nameservers to be delegated to Vercel (ns1/ns2.vercel-dns.com) so that
// adding a first-level subdomain to a project needs no further manual DNS —
// see https://docs.vercel.com/docs/domains/working-with-nameservers.
const BRANDED_DOMAIN_APEX=process.env.BRANDED_DOMAIN_APEX||"utplava.dev";
function brandedHostForSlug(slug:string){return `${sanitizedProjectSlug(slug)}.${BRANDED_DOMAIN_APEX}`}

// Attaches <slug>.utplava.dev to the project if it isn't already there.
// Idempotent: a GET first (404-tolerant) avoids relying on fragile 400
// error-message parsing to detect "already attached to this project" ---
// Vercel's add-domain endpoint returns a plain 400 for that case with no
// distinguishing code, so checking first is the only clean way to tell it
// apart from a real failure. A 409 (domain already claimed by a DIFFERENT
// Vercel project --- i.e. a slug collision across workspaces, since apps.slug
// is only unique per-workspace, not globally) is reported back rather than
// silently retried or papered over.
async function ensureBrandedDomain(projectId:string,host:string):Promise<{attached:boolean;verified:boolean;conflict:boolean}>{
 const existing=await vercelRequestOptional(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(host)}${teamQuery()}`);
 if(existing)return{attached:true,verified:Boolean(existing.verified),conflict:false};
 try{
  const created=await vercelRequest(`/v10/projects/${encodeURIComponent(projectId)}/domains${teamQuery()}`,{method:"POST",body:JSON.stringify({name:host})});
  return{attached:true,verified:Boolean(created?.verified),conflict:false};
 }catch(error:any){
  if(error?.status===409)return{attached:false,verified:false,conflict:true};
  throw error;
 }
}

// Best-effort: never allowed to affect the deployment's real LIVE status or
// throw into the caller. A branded-domain hiccup (DNS not propagated yet,
// slug collision, transient Vercel error) must never strand or fail a
// deployment that is otherwise genuinely live on its real provider URL.
async function attachBrandedDomainBestEffort(db:pg.Client,{deploymentId,providerProjectId,slug,fromStatus}:{deploymentId:string;providerProjectId:string;slug:string;fromStatus:string}){
 const brandedHost=brandedHostForSlug(slug);
 try{
  const outcome=await ensureBrandedDomain(providerProjectId,brandedHost);
  if(outcome.conflict){
   await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'BRANDED_DOMAIN_CONFLICT','Branded subdomain is already claimed by a different project',$3::jsonb)`,[deploymentId,fromStatus,JSON.stringify({brandedHost,providerProjectId})]);
   return;
  }
  if(!outcome.verified){
   await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'BRANDED_DOMAIN_PENDING','Branded subdomain attached but not yet verified',$3::jsonb)`,[deploymentId,fromStatus,JSON.stringify({brandedHost,providerProjectId})]);
   return;
  }
  const brandedUrl=`https://${brandedHost}`;
  await db.query(`UPDATE deployments SET live_url=$1,updated_at=now() WHERE id=$2 AND status='LIVE'`,[brandedUrl,deploymentId]);
  await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'BRANDED_DOMAIN_ATTACHED','Branded subdomain verified and set as the live URL',$3::jsonb)`,[deploymentId,fromStatus,JSON.stringify({brandedHost,providerProjectId,brandedUrl})]);
 }catch(error:any){
  await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'BRANDED_DOMAIN_ERROR','Attaching the branded subdomain hit an unexpected error',$3::jsonb)`,[deploymentId,fromStatus,JSON.stringify({brandedHost,providerProjectId,errorMessage:String(error?.message??error),errorName:error?.name??null})]).catch(()=>{});
 }
}

export const configurePublicAccess=task({id:"ssc-control-plane-configure-public-access",retry:{maxAttempts:2,minTimeoutInMs:2000,maxTimeoutInMs:8000,factor:2,randomize:false},run:async(payload:{deploymentId:string})=>{
 if(!process.env.DATABASE_URL)throw new Error("Missing DATABASE_URL");const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
 try{
  const result=await db.query(`SELECT d.id,d.status,d.live_url,d.source_commit_sha,a.slug,rt.provider,rt.provider_project_id,b.provider_deployment_id,b.provider_deployment_url,b.status AS build_status FROM deployments d JOIN apps a ON a.id=d.app_id JOIN app_runtimes rt ON rt.app_id=d.app_id JOIN deployment_builds b ON b.deployment_id=d.id WHERE d.id=$1`,[payload.deploymentId]);
  if(result.rowCount===0)throw new Error(`Deployment/runtime/build not found: ${payload.deploymentId}`);const row=result.rows[0];if(row.provider!=="vercel")throw new Error(`Unsupported runtime provider: ${row.provider}`);const action=publicAccessRecoveryAction(row.status);if(action.action==="terminal-noop")return{result:"NODE_04_18_TERMINAL_NOOP",deploymentId:payload.deploymentId,status:row.status,publiclyReachable:false,responseBodyStored:false,target:"production"};if(action.action==="live-replay-noop"){await attachBrandedDomainBestEffort(db,{deploymentId:payload.deploymentId,providerProjectId:row.provider_project_id,slug:row.slug,fromStatus:"LIVE"});return{result:"NODE_04_18_PUBLIC_ACCESS_REPLAY_NOOP",deploymentId:payload.deploymentId,providerProjectId:row.provider_project_id,providerDeploymentId:row.provider_deployment_id,checkUrl:row.live_url,publiclyReachable:true,status:"LIVE",responseBodyStored:false,target:"production"}}if(action.action!=="verify-public-access")throw new Error(`Production public verification requires HEALTH_CHECKING or LIVE; current status is ${row.status}`);
  const providerDeployment=await vercelRequest(`/v13/deployments/${encodeURIComponent(row.provider_deployment_id)}${teamQuery()}`);
  const deploymentIdentity=verifyProviderDeploymentIdentity(providerDeployment,{deploymentId:row.id,providerDeploymentId:row.provider_deployment_id,providerProjectId:row.provider_project_id});
  if(deploymentIdentity.status!==ProviderDeploymentIdentityStatus.MATCH)throw new Error(`Provider deployment identity could not be verified: ${deploymentIdentity.status}`);
  const sourceIdentity=verifyProviderSourceIdentity(providerDeployment,row.source_commit_sha);
  if(row.build_status!=="READY"||sourceIdentity.status!==SourceIdentityStatus.MATCH)throw new Error(`Public access requires a verified provider build; build status is ${row.build_status}, source identity is ${sourceIdentity.status}`);
  if(providerDeployment?.target!=="production")throw new Error(`Provider deployment is not production-targeted; target is ${providerDeployment?.target??"null"}`);
  if((providerDeployment?.readyState??providerDeployment?.state)!=="READY")throw new Error(`Provider production deployment is not READY`);
  const project=await vercelRequest(`/v9/projects/${encodeURIComponent(row.provider_project_id)}${teamQuery()}`);
  const productionHosts=publicBindingHostCandidates({providerDeployment,project});
  const deploymentAliases=await vercelRequestOptional(`/v2/deployments/${encodeURIComponent(row.provider_deployment_id)}/aliases${teamQuery()}`);
  let publicBinding:any={status:PublicBindingStatus.UNAVAILABLE,canonicalHost:productionHosts[0]??null};let productionHost=productionHosts[0]??`${project.name}.vercel.app`;
  for(const candidateHost of productionHosts){const alias=await vercelRequestOptional(`/v4/aliases/${encodeURIComponent(candidateHost)}${teamQuery({projectId:row.provider_project_id})}`);const candidateBinding=verifyPublicBinding({alias,deploymentAliases,canonicalHost:candidateHost,providerDeploymentId:row.provider_deployment_id,providerProjectId:row.provider_project_id});if(candidateBinding.status===PublicBindingStatus.MATCH){publicBinding=candidateBinding;productionHost=candidateHost;break}if(publicBinding.status===PublicBindingStatus.UNAVAILABLE)publicBinding=candidateBinding}
  const checkUrl=`https://${productionHost}`;
  if(publicBinding.status!==PublicBindingStatus.MATCH){await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'PUBLIC_BINDING_UNVERIFIED','Production URL is not proven to point at the verified provider deployment',$3::jsonb)`,[payload.deploymentId,row.status,JSON.stringify({checkUrl,providerDeploymentId:row.provider_deployment_id,providerProjectId:row.provider_project_id,publicBindingStatus:publicBinding.status,aliasDeploymentId:publicBinding.aliasDeploymentId??null,aliasProjectId:publicBinding.aliasProjectId??null,listedOnDeployment:publicBinding.listedOnDeployment??false,responseBodyStored:false,target:"production"})]);return{result:"NODE_15R_7_PUBLIC_BINDING_UNVERIFIED",deploymentId:payload.deploymentId,providerProjectId:row.provider_project_id,providerDeploymentId:row.provider_deployment_id,checkUrl,publicBindingStatus:publicBinding.status,publiclyReachable:false,status:row.status,responseBodyStored:false,target:"production"}}
  const checked=await anonymousCheck(checkUrl);const redirectLocationHost=checked.location?(()=>{try{return new URL(checked.location,checkUrl).hostname}catch{return null}})():null;
  if(checked.publiclyReachable){await db.query("BEGIN");try{await db.query(`UPDATE deployments SET status='LIVE',live_url=$1,error_code=NULL,error_message=NULL,finished_at=now(),updated_at=now() WHERE id=$2 AND status='HEALTH_CHECKING'`,[checkUrl,payload.deploymentId]);await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'HEALTH_CHECKING','LIVE','PUBLIC_ACCESS_VERIFIED','Healthy production deployment is publicly reachable',$2::jsonb)`,[payload.deploymentId,JSON.stringify({checkUrl,httpStatus:checked.httpStatus,latencyMs:checked.latencyMs,redirectLocationHost,vercelAuthRedirect:checked.vercelAuthRedirect,redirectUnsafe:checked.redirectUnsafe,responseBodyStored:false,providerDeploymentId:row.provider_deployment_id,providerProjectId:row.provider_project_id,sourceIdentityStatus:sourceIdentity.status,publicBindingStatus:publicBinding.status,target:"production"})]);await db.query("COMMIT")}catch(error){await db.query("ROLLBACK");throw error}await attachBrandedDomainBestEffort(db,{deploymentId:payload.deploymentId,providerProjectId:row.provider_project_id,slug:row.slug,fromStatus:"LIVE"})}
  else{await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'PUBLIC_ACCESS_BLOCKED','Production deployment is not publicly reachable without provider authentication',$3::jsonb)`,[payload.deploymentId,row.status,JSON.stringify({checkUrl,httpStatus:checked.httpStatus,latencyMs:checked.latencyMs,redirectLocationHost,vercelAuthRedirect:checked.vercelAuthRedirect,redirectUnsafe:checked.redirectUnsafe,responseBodyStored:false})])}
  return{result:checked.publiclyReachable?"NODE_04_11_PUBLIC_ACCESS_VERIFIED":"NODE_04_11_PUBLIC_ACCESS_BLOCKED",deploymentId:payload.deploymentId,providerProjectId:row.provider_project_id,providerDeploymentId:row.provider_deployment_id,checkUrl,httpStatus:checked.httpStatus,latencyMs:checked.latencyMs,redirectLocationHost,vercelAuthRedirect:checked.vercelAuthRedirect,redirectUnsafe:checked.redirectUnsafe,publiclyReachable:checked.publiclyReachable,status:checked.publiclyReachable?"LIVE":row.status,responseBodyStored:false,sourceIdentityStatus:sourceIdentity.status,publicBindingStatus:publicBinding.status,target:"production"};
 }catch(error:any){
  // Final gate before LIVE — the same unbounded-fetch-without-trace failure
  // mode already found and fixed at PROVISIONING/BUILDING stages can strand
  // a deployment at HEALTH_CHECKING just as silently. Best-effort insert;
  // a failed insert must never mask the real error.
  await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'HEALTH_CHECKING','HEALTH_CHECKING','PUBLIC_ACCESS_CONFIGURE_ERROR',$2,$3::jsonb)`,[payload.deploymentId,"Configuring public access hit an unexpected error.",JSON.stringify({errorMessage:String(error?.message??error),errorName:error?.name??null})]).catch(()=>{});
  throw error;
 }finally{await db.end()}
}});
