import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { decryptAppSecret } from "../src/secret-store.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";
const MAX_EVENTS = 200;
const MAX_MESSAGE_CHARS = 4000;

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
}

function normalizeMessage(event: any) {
  const raw = event?.text ?? event?.message ?? event?.payload?.text ?? event?.payload?.message ?? "";
  return String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, MAX_MESSAGE_CHARS);
}

function severity(event: any) {
  const type = String(event?.type ?? event?.level ?? event?.payload?.type ?? "info").toLowerCase();
  if (["fatal", "error", "stderr", "exit"].includes(type)) return "error";
  if (["warning", "warn"].includes(type)) return "warning";
  return "info";
}

function redact(message: string, secrets: string[]) {
  let safe = message;
  for (const value of secrets) {
    if (!value || value.length < 4) continue;
    safe = safe.split(value).join("[REDACTED]");
    try {
      const encoded = encodeURIComponent(value);
      if (encoded !== value) safe = safe.split(encoded).join("[REDACTED]");
    } catch {}
  }
  safe = safe.replace(/\b(?:sk|pk|rk|key|token|secret)[-_][A-Za-z0-9._-]{12,}\b/gi, "[REDACTED]");
  safe = safe.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]");
  safe = safe.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  return safe;
}

export const ingestBuildLogs = task({
  id: "ssc-control-plane-ingest-build-logs",
  retry: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 8000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query(
        `SELECT d.app_id, b.provider, b.provider_deployment_id
           FROM deployment_builds b
           JOIN deployments d ON d.id=b.deployment_id
          WHERE b.deployment_id=$1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) return { result: "NODE_04_12_BUILD_NOT_AVAILABLE", deploymentId: payload.deploymentId };
      const build = result.rows[0];
      if (build.provider !== "vercel") throw new Error(`Unsupported log provider: ${build.provider}`);

      const secretRows = await db.query(`SELECT name FROM encrypted_secrets WHERE app_id=$1 ORDER BY name`, [build.app_id]);
      const plaintextSecrets: string[] = [];
      try {
        for (const row of secretRows.rows) {
          const value = await decryptAppSecret(db, { appId: build.app_id, name: row.name });
          if (value) plaintextSecrets.push(value);
        }

        const url = `${API}/v3/deployments/${encodeURIComponent(build.provider_deployment_id)}/events?direction=forward&follow=0&limit=${MAX_EVENTS}${teamQuery()}`;
        const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } });
        if (!response.ok) throw new Error(`Vercel build log lookup failed: ${response.status} ${response.statusText}`);
        const body: any = await response.json();
        const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [];

        await db.query(`DELETE FROM deployment_logs WHERE deployment_id=$1 AND source='build'`, [payload.deploymentId]);
        let stored = 0;
        for (const event of events.slice(0, MAX_EVENTS)) {
          const rawMessage = normalizeMessage(event);
          if (!rawMessage) continue;
          const message = redact(rawMessage, plaintextSecrets);
          const timestamp = event?.created ?? event?.createdAt ?? event?.timestamp ?? event?.date ?? null;
          const providerTimestamp = typeof timestamp === "number" ? new Date(timestamp).toISOString() : timestamp;
          await db.query(
            `INSERT INTO deployment_logs
               (deployment_id,source,provider,provider_deployment_id,severity,message,provider_timestamp)
             VALUES ($1,'build','vercel',$2,$3,$4,$5)`,
            [payload.deploymentId, build.provider_deployment_id, severity(event), message, providerTimestamp],
          );
          stored++;
        }

        return {
          result: "NODE_04_12_BUILD_LOGS_INGESTED",
          deploymentId: payload.deploymentId,
          providerDeploymentId: build.provider_deployment_id,
          fetchedCount: Math.min(events.length, MAX_EVENTS),
          storedCount: stored,
          maxEvents: MAX_EVENTS,
          maxMessageChars: MAX_MESSAGE_CHARS,
          secretValuesPersisted: false,
          rawProviderDumpPersisted: false,
        };
      } finally {
        for (let i = 0; i < plaintextSecrets.length; i++) plaintextSecrets[i] = "";
      }
    } finally {
      await db.end();
    }
  },
});
