import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const API = "https://api.vercel.com";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}
function safeVercelError(body:any){
  const error=body?.error ?? body;
  return {
    code: typeof error?.code === "string" ? error.code.slice(0,120) : null,
    message: typeof error?.message === "string" ? error.message.slice(0,500) : null,
  };
}
async function vercelRequest(path:string,options:RequestInit={}) {
  if(!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const response=await fetch(`${API}${path}`,{...options,headers:{Authorization:`Bearer ${process.env.VERCEL_TOKEN}`,"Content-Type":"application/json",...(options.headers??{})}});
  const text=await response.text(); let body:any=null; if(text){try{body=JSON.parse(text)}catch{body=null}}
  if(!response.ok){
    const detail=safeVercelError(body);
    const suffix=[detail.code,detail.message].filter(Boolean).join(": ");
    throw new Error(`Vercel API ${response.status} ${response.statusText}${suffix?` - ${suffix}`:""}`);
  }
  return body;
}
function isVercelAuthRedirect(location:string|null){if(!location)return false;try{const u=new URL(location);return u.hostname==="vercel.com"||u.hostname.endsWith(".vercel.com")}catch{return /vercel\.com/i.test(location)}}
async function anonymousCheck(url:string){const started=Date.now();const response=await fetch(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(8000),headers:{"User-Agent":BROWSER_UA,Accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}});const latencyMs=Date.now()-started;const location=response.headers.get("location");const vercelAuthRedirect=isVercelAuthRedirect(location);const publiclyReachable=!vercelAuthRedirect&&response.status>=200&&response.status<400;try{await response.body?.cancel()}catch{}return{httpStatus:response.status,latencyMs,location,vercelAuthRedirect,publiclyReachable}}

export const configurePublicAccess=task({
 id:"ssc-control-plane-configure-public-access",retry:{maxAttempts:2,minTimeoutInMs:2000,maxTimeoutInMs:8000,factor:2,randomize:false},
 run:async(payload:{deploymentId:string})=>{
  if(!process.env.DATABASE_URL)throw new Error("Missing DATABASE_URL");const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
  try{
   const result=await db.query(`SELECT d.id,d.status,d.live_url,rt.provider,rt.provider_project_id,b.provider_deployment_id,b.provider_deployment_url FROM deployments d JOIN app_runtimes rt ON rt.app_id=d.app_id JOIN deployment_builds b ON b.deployment_id=d.id WHERE d.id=$1`,[payload.deploymentId]);
   if(result.rowCount===0)throw new Error(`Deployment/runtime/build not found: ${payload.deploymentId}`);const row=result.rows[0];
   if(row.provider!=="vercel")throw new Error(`Unsupported runtime provider: ${row.provider}`);
   if(!["HEALTH_CHECKING","LIVE"].includes(row.status))throw new Error(`Production promotion requires HEALTH_CHECKING or LIVE; current status is ${row.status}`);

   await vercelRequest(`/v10/projects/${encodeURIComponent(row.provider_project_id)}/promote/${encodeURIComponent(row.provider_deployment_id)}${teamQuery()}`,{method:"POST"});

   const project=await vercelRequest(`/v9/projects/${encodeURIComponent(row.provider_project_id)}${teamQuery()}`);
   const productionHost=(Array.isArray(project?.alias)&&project.alias[0]) || (Array.isArray(project?.domains)&&project.domains.find((d:string)=>d===`${project.name}.vercel.app`)) || `${project.name}.vercel.app`;
   const checkUrl=`https://${productionHost}`;
   const checked=await anonymousCheck(checkUrl);
   const redirectLocationHost=checked.location?(()=>{try{return new URL(checked.location).hostname}catch{return null}})():null;

   if(checked.publiclyReachable){
    await db.query("BEGIN");
    try{
     await db.query(`UPDATE deployments SET status='LIVE',live_url=$1,error_code=NULL,error_message=NULL,finished_at=now(),updated_at=now() WHERE id=$2 AND status='HEALTH_CHECKING'`,[checkUrl,payload.deploymentId]);
     await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'HEALTH_CHECKING','LIVE','PUBLIC_ACCESS_VERIFIED','Verified deployment promoted and public production access confirmed',$2::jsonb)`,[payload.deploymentId,JSON.stringify({checkUrl,httpStatus:checked.httpStatus,latencyMs:checked.latencyMs,redirectLocationHost,vercelAuthRedirect:checked.vercelAuthRedirect,responseBodyStored:false,providerDeploymentId:row.provider_deployment_id})]);
     await db.query("COMMIT");
    }catch(error){await db.query("ROLLBACK");throw error}
   }else{
    await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,$2,$2,'PUBLIC_ACCESS_BLOCKED','Promoted deployment is not publicly reachable without provider authentication',$3::jsonb)`,[payload.deploymentId,row.status,JSON.stringify({checkUrl,httpStatus:checked.httpStatus,latencyMs:checked.latencyMs,redirectLocationHost,vercelAuthRedirect:checked.vercelAuthRedirect,responseBodyStored:false})]);
   }
   return{result:checked.publiclyReachable?"NODE_04_11_PUBLIC_ACCESS_VERIFIED":"NODE_04_11_PUBLIC_ACCESS_BLOCKED",deploymentId:payload.deploymentId,providerProjectId:row.provider_project_id,providerDeploymentId:row.provider_deployment_id,checkUrl,httpStatus:checked.httpStatus,latencyMs:checked.latencyMs,redirectLocationHost,vercelAuthRedirect:checked.vercelAuthRedirect,publiclyReachable:checked.publiclyReachable,status:checked.publiclyReachable?"LIVE":row.status,responseBodyStored:false};
  }finally{await db.end()}
 }
});
