const API = "https://api.vercel.com";

if (!process.env.VERCEL_TOKEN) throw new Error("Missing required environment variable: VERCEL_TOKEN");

const projectId = process.env.SOURCE_VERCEL_PROJECT_ID;
if (!projectId) throw new Error("Missing required environment variable: SOURCE_VERCEL_PROJECT_ID");

const teamId = process.env.VERCEL_TEAM_ID;
const query = new URLSearchParams({ decrypt: "false" });
if (teamId) query.set("teamId", teamId);

const response = await fetch(`${API}/v10/projects/${encodeURIComponent(projectId)}/env?${query.toString()}`, {
  headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
});

const text = await response.text();
let body;
try { body = text ? JSON.parse(text) : null; } catch { body = text; }
if (!response.ok) throw new Error(`Vercel API ${response.status} ${response.statusText}`);

const envs = Array.isArray(body?.envs) ? body.envs : [];
const production = envs
  .filter((item) => Array.isArray(item.target) && item.target.includes("production"))
  .map((item) => ({
    id: item.id,
    key: item.key,
    type: item.type,
    target: item.target,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
  }))
  .sort((a, b) => a.key.localeCompare(b.key));

console.log(JSON.stringify({
  result: "SOURCE_VERCEL_ENV_INVENTORY",
  projectId,
  productionCount: production.length,
  variables: production,
  valuesRequested: false,
  valuesPrinted: false,
}, null, 2));
