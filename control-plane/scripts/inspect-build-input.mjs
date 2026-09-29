import pg from "pg";

for (const name of ["DATABASE_URL", "DEPLOYMENT_ID"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(
    `SELECT deployment_id, repository_full_name, commit_sha, manifest, manifest->>'framework' AS framework_as_text
       FROM deployment_build_inputs WHERE deployment_id = $1`,
    [process.env.DEPLOYMENT_ID],
  );
  console.log(JSON.stringify(result.rows[0] ?? { result: "NOT_FOUND" }, null, 2));
} finally {
  await db.end();
}
