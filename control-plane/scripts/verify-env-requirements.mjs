import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
const appSlug = process.env.CONTROL_PLANE_APP_SLUG || "vantage";
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(
    `SELECT r.env_key, r.required, r.public, r.source,
            b.id IS NOT NULL AS configured
       FROM app_env_requirements r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN app_secret_bindings b
         ON b.app_id = r.app_id
        AND b.env_key = r.env_key
        AND b.target_environment = 'production'
      WHERE lower(a.slug) = lower($1)
      ORDER BY r.env_key`,
    [appSlug],
  );
  const requirements = result.rows.map((row) => ({
    envKey: row.env_key,
    required: row.required,
    public: row.public,
    source: row.source,
    configured: row.configured,
  }));
  const missing = requirements.filter((item) => item.required && !item.configured).map((item) => item.envKey);
  const snapshot = await db.query(
    `SELECT s.deployment_id, s.commit_sha, s.git_tree_sha, s.root_directory,
            s.detector_version, s.detected_count, s.scanned_file_count, s.skipped_file_count,
            s.created_at
       FROM deployment_env_detection_snapshots s
       JOIN apps a ON a.id = s.app_id
      WHERE lower(a.slug) = lower($1)
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [appSlug],
  );
  console.log(JSON.stringify({
    result: missing.length ? "NODE_04_9_ENV_INPUT_REQUIRED" : "NODE_04_9_ENV_READY",
    appSlug,
    latestDetectionSnapshot: snapshot.rowCount ? {
      deploymentId: snapshot.rows[0].deployment_id,
      commitSha: snapshot.rows[0].commit_sha,
      gitTreeSha: snapshot.rows[0].git_tree_sha,
      rootDirectory: snapshot.rows[0].root_directory,
      detectorVersion: snapshot.rows[0].detector_version,
      detectedCount: Number(snapshot.rows[0].detected_count),
      scannedFileCount: Number(snapshot.rows[0].scanned_file_count),
      skippedFileCount: Number(snapshot.rows[0].skipped_file_count),
      createdAt: snapshot.rows[0].created_at,
    } : null,
    requirementCount: requirements.length,
    configuredCount: requirements.length - missing.length,
    missingCount: missing.length,
    requirements,
    missing,
    valuesPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
