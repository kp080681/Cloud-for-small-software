import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const API = "https://api.vercel.com";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

async function vercelRequest(path: string, options: RequestInit = {}) {
  if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) throw new Error(`Vercel API ${response.status} ${response.statusText}`);
  return body;
}

function isVercelAuthRedirect(location: string | null) {
  if (!location) return false;
  try {
    const url = new URL(location);
    return url.hostname === "vercel.com" || url.hostname.endsWith(".vercel.com");
  } catch {
    return /vercel\.com/i.test(location);
  }
}

export const configurePublicAccess = task({
  id: "ssc-control-plane-configure-public-access",
  retry: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 8000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query(
        `SELECT d.id, d.status, d.live_url,
                rt.provider, rt.provider_project_id,
                b.provider_deployment_url
           FROM deployments d
           JOIN app_runtimes rt ON rt.app_id=d.app_id
           LEFT JOIN deployment_builds b ON b.deployment_id=d.id
          WHERE d.id=$1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Deployment/runtime not found: ${payload.deploymentId}`);
      const row = result.rows[0];
      if (row.provider !== "vercel") throw new Error(`Unsupported runtime provider: ${row.provider}`);

      await vercelRequest(`/v9/projects/${encodeURIComponent(row.provider_project_id)}${teamQuery()}`, {
        method: "PATCH",
        body: JSON.stringify({ ssoProtection: null }),
      });

      const checkUrl = row.live_url || row.provider_deployment_url;
      if (!checkUrl) throw new Error("No deployment URL available for public-access verification");
      const parsed = new URL(checkUrl);
      if (parsed.protocol !== "https:") throw new Error("Public runtime URL must use HTTPS");

      const started = Date.now();
      const response = await fetch(checkUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const latencyMs = Date.now() - started;
      const location = response.headers.get("location");
      const vercelAuthRedirect = isVercelAuthRedirect(location);
      const publiclyReachable = !vercelAuthRedirect && response.status >= 200 && response.status < 400;
      try { await response.body?.cancel(); } catch {}

      await db.query(
        `INSERT INTO deployment_events
           (deployment_id,from_status,to_status,event_type,message,metadata)
         VALUES ($1,$2,$2,$3,$4,$5::jsonb)`,
        [
          payload.deploymentId,
          row.status,
          publiclyReachable ? "PUBLIC_ACCESS_VERIFIED" : "PUBLIC_ACCESS_BLOCKED",
          publiclyReachable ? "Unauthenticated public access verified" : "Deployment is not publicly reachable without provider authentication",
          JSON.stringify({
            checkUrl,
            httpStatus: response.status,
            latencyMs,
            redirectLocationHost: location ? (() => { try { return new URL(location).hostname; } catch { return null; } })() : null,
            vercelAuthRedirect,
            responseBodyStored: false,
          }),
        ],
      );

      return {
        result: publiclyReachable ? "NODE_04_11_PUBLIC_ACCESS_VERIFIED" : "NODE_04_11_PUBLIC_ACCESS_BLOCKED",
        deploymentId: payload.deploymentId,
        providerProjectId: row.provider_project_id,
        checkUrl,
        httpStatus: response.status,
        latencyMs,
        redirectLocationHost: location ? (() => { try { return new URL(location).hostname; } catch { return null; } })() : null,
        vercelAuthRedirect,
        publiclyReachable,
        responseBodyStored: false,
      };
    } finally {
      await db.end();
    }
  },
});
