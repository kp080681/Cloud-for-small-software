import crypto from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { enforceDeploymentCreationLimit } from "../src/workspace-resource-policy.mjs";

const { Client } = pg;

export const createRedeployment = task({
  id: "ssc-control-plane-create-redeployment",
  retry: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 8000, factor: 2, randomize: false },
  run: async (payload: { appId: string }) => {
    for (const name of ["DATABASE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) if (!process.env[name]) throw new Error(`Missing ${name}`);
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const appResult = await db.query(`SELECT a.id,a.workspace_id,a.slug,r.full_name AS repository_full_name,r.default_branch,i.github_installation_id,d.id AS previous_deployment_id,d.source_commit_sha AS previous_commit_sha FROM apps a JOIN github_repositories r ON r.id=a.repository_id JOIN github_installations i ON i.id=r.github_installation_id LEFT JOIN LATERAL (SELECT id,source_commit_sha FROM deployments WHERE app_id=a.id AND status='LIVE' ORDER BY created_at DESC LIMIT 1) d ON true WHERE a.id=$1 AND a.deleted_at IS NULL`,[payload.appId]);
      if(appResult.rowCount===0)throw new Error(`Active app not found: ${payload.appId}`);const app=appResult.rows[0];if(!app.previous_deployment_id)throw new Error("Redeploy requires an existing LIVE deployment");
      const [owner,repo]=app.repository_full_name.split("/");const auth=createAppAuth({appId:process.env.GITHUB_APP_ID!,privateKey:process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g,"\n")});const installationAuth=await auth({type:"installation",installationId:Number(app.github_installation_id)});const octokit=new Octokit({auth:installationAuth.token});const branch=app.default_branch||"main";const ref=await octokit.git.getRef({owner,repo,ref:`heads/${branch}`});const commitSha=ref.data.object.sha;if(!/^[0-9a-f]{40}$/i.test(commitSha))throw new Error("GitHub returned an invalid commit SHA");
      await db.query("BEGIN");try{
        await db.query(`SELECT id FROM apps WHERE id=$1 FOR UPDATE`,[app.id]);
        const active=await db.query(`SELECT id,deployment_key,source_commit_sha,status FROM deployments WHERE app_id=$1 AND status IN ('DRAFT','READY','QUEUED','ANALYZING','PROVISIONING','BUILDING','DEPLOYING','HEALTH_CHECKING','DELETING') ORDER BY created_at DESC LIMIT 1`,[app.id]);
        if(active.rowCount>0){await db.query("COMMIT");return{result:"NODE_04_16_REDEPLOY_ALREADY_IN_PROGRESS",appId:app.id,deploymentId:active.rows[0].id,deploymentKey:active.rows[0].deployment_key,commitSha:active.rows[0].source_commit_sha,status:active.rows[0].status}}
        await enforceDeploymentCreationLimit(db,{workspaceId:app.workspace_id,appId:app.id});
        const deploymentKey=`dep_${crypto.randomUUID().replaceAll("-","")}`;const created=await db.query(`INSERT INTO deployments (deployment_key,workspace_id,app_id,source_commit_sha,source_branch,status,parent_deployment_id,deployment_reason,runtime_project_id) SELECT $1,$2,$3,$4,$5,'ANALYZING',$6,'redeploy',rt.provider_project_id FROM app_runtimes rt WHERE rt.app_id=$3 RETURNING id,deployment_key,source_commit_sha,source_branch,status,parent_deployment_id,deployment_reason`,[deploymentKey,app.workspace_id,app.id,commitSha,branch,app.previous_deployment_id]);if(created.rowCount!==1)throw new Error("App runtime is missing; cannot redeploy");const deployment=created.rows[0];
        await db.query(`INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata) VALUES ($1,'READY','ANALYZING','REDEPLOY_CREATED','Redeployment created from current repository head',$2::jsonb)`,[deployment.id,JSON.stringify({parentDeploymentId:app.previous_deployment_id,previousCommitSha:app.previous_commit_sha,commitSha,branch})]);await db.query("COMMIT");
        return{result:"NODE_04_16_REDEPLOY_CREATED",appId:app.id,deploymentId:deployment.id,deploymentKey:deployment.deployment_key,parentDeploymentId:deployment.parent_deployment_id,previousCommitSha:app.previous_commit_sha,commitSha:deployment.source_commit_sha,branch:deployment.source_branch,status:deployment.status,sourceChanged:app.previous_commit_sha!==deployment.source_commit_sha,installationTokenPrinted:false,privateKeyPrinted:false};
      }catch(error){await db.query("ROLLBACK");throw error}
    }finally{await db.end()}
  }
});
