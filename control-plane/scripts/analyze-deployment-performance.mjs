import pg from "pg";
import { loadDeploymentDiagnosticContext } from "../src/deployment-diagnostic-context.mjs";
import { normalizeDeploymentDiagnostic } from "../src/deployment-diagnostics.mjs";
import { normalizeDeploymentTimeline } from "../src/deployment-timeline.mjs";
import { normalizeDeploymentPerformance, summarizeReadTimings } from "../src/deployment-performance.mjs";

const { Client } = pg;

const DEPLOYMENTS = [
  { label: "DealUp", deploymentId: "fc494742-a56c-4050-8df0-0a667f32efa7" },
  { label: "Vantage", deploymentId: "e1f03cb5-85e6-4261-aeed-a32f5f18e4ae" },
  { label: "Recovery Test LIVE", deploymentId: "38a1dbc8-e200-45ae-9b42-a589ceb914dc" },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function timed(label, fn) {
  const started = nowMs();
  const result = await fn();
  return { label, durationMs: nowMs() - started, result };
}

async function connect() {
  const db = new Client({ connectionString: requireEnv("DATABASE_URL") });
  await db.connect();
  return db;
}

async function simpleLookup(db, deploymentId) {
  const result = await db.query(
    `SELECT d.id, d.status, d.live_url, a.slug AS app_slug
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
      WHERE d.id = $1`,
    [deploymentId],
  );
  if (result.rowCount !== 1) throw new Error(`Deployment not found: ${deploymentId}`);
  return result.rows[0];
}

async function publicLatencySample(url) {
  if (!url) return null;
  const started = nowMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "Small-Software-Cloud-Performance-Probe/1.0" },
    });
    try {
      await response.body?.cancel();
    } catch {}
    return {
      urlHost: new URL(url).hostname,
      status: response.status,
      durationMs: nowMs() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const db = await connect();

try {
  const deployments = [];
  const readSamples = [];
  const runtimeLatencySamples = [];

  for (const item of DEPLOYMENTS) {
    const diagnosticRead = await timed(`${item.label} diagnostic`, async () => {
      const context = await loadDeploymentDiagnosticContext(db, item.deploymentId);
      const diagnostic = normalizeDeploymentDiagnostic(context);
      return { context, diagnostic };
    });
    readSamples.push({ label: diagnosticRead.label, durationMs: diagnosticRead.durationMs });

    const timelineRead = await timed(`${item.label} timeline`, async () => {
      const context = await loadDeploymentDiagnosticContext(db, item.deploymentId, { eventLimit: null });
      const diagnostic = normalizeDeploymentDiagnostic(context);
      return normalizeDeploymentTimeline(context, diagnostic);
    });
    readSamples.push({ label: timelineRead.label, durationMs: timelineRead.durationMs });

    const lookupRead = await timed(`${item.label} lookup`, () => simpleLookup(db, item.deploymentId));
    readSamples.push({ label: lookupRead.label, durationMs: lookupRead.durationMs });

    const performance = normalizeDeploymentPerformance(timelineRead.result);
    deployments.push({
      label: item.label,
      ...performance,
      currentStatus: timelineRead.result.currentStatus,
      diagnosticCode: timelineRead.result.diagnostic.code,
      diagnosticSeverity: timelineRead.result.diagnostic.severity,
    });

    if (timelineRead.result.currentStatus === "LIVE" && timelineRead.result.diagnostic.evidence?.liveUrl) {
      for (let sample = 1; sample <= 3; sample += 1) {
        runtimeLatencySamples.push({
          label: item.label,
          sample,
          ...(await publicLatencySample(timelineRead.result.diagnostic.evidence.liveUrl)),
        });
      }
    }
  }

  const readSummary = summarizeReadTimings(readSamples);

  console.log(JSON.stringify({
    result: "NODE_17_PERFORMANCE_ANALYSIS",
    deployments,
    controlPlaneReadSamples: readSamples,
    controlPlaneReadSummary: {
      p50Ms: readSummary.p50Ms,
      maxMs: readSummary.maxMs,
      sampleCount: readSummary.count,
    },
    runtimeLatencySamples,
    architecture: {
      sscRuntimeProxyPresent: false,
      asyncInfraOperations: true,
      providerCallsExecuted: false,
      triggerCallsExecuted: false,
      databaseWritesExecuted: false,
    },
  }, null, 2));
} finally {
  await db.end();
}
