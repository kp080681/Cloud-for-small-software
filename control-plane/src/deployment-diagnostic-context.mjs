function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

export async function loadDeploymentDiagnosticContext(db, deploymentId, { eventLimit = 25 } = {}) {
  const deploymentResult = await db.query(
    `SELECT d.id,
            d.deployment_key,
            d.app_id,
            d.status,
            d.source_commit_sha,
            d.source_branch,
            d.runtime_project_id,
            d.provider_deployment_id,
            d.live_url,
            d.error_code,
            d.created_at,
            d.queued_at,
            d.started_at,
            d.updated_at,
            d.finished_at,
            a.slug AS app_slug,
            COALESCE(p.policy_tier,'starter') AS policy_tier,
            COALESCE(p.max_build_minutes,15) AS max_build_minutes,
            COALESCE(p.max_health_attempts,3) AS max_health_attempts
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN app_resource_policies p ON p.app_id = d.app_id
      WHERE d.id = $1`,
    [deploymentId],
  );
  if (deploymentResult.rowCount === 0) throw new Error(`Deployment not found: ${deploymentId}`);
  const deployment = deploymentResult.rows[0];

  const [
    eventResult,
    buildResult,
    healthResult,
    healthCountResult,
    envResult,
    envSnapshotResult,
    logCountResult,
    operationResult,
  ] = await Promise.all([
    eventLimit === null
      ? db.query(
        `SELECT id, event_type, from_status, to_status, metadata, created_at
           FROM deployment_events
          WHERE deployment_id = $1
          ORDER BY created_at DESC, id DESC`,
        [deploymentId],
      )
      : db.query(
        `SELECT id, event_type, from_status, to_status, metadata, created_at
           FROM deployment_events
          WHERE deployment_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [deploymentId, eventLimit],
      ),
    db.query(
      `SELECT provider, provider_deployment_id, provider_deployment_url, source_commit_sha, status, updated_at
         FROM deployment_builds
        WHERE deployment_id = $1`,
      [deploymentId],
    ),
    db.query(
      `SELECT attempt_number, status, http_status, latency_ms, error_code, checked_at
         FROM deployment_health_checks
        WHERE deployment_id = $1
        ORDER BY checked_at DESC
        LIMIT 1`,
      [deploymentId],
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM deployment_health_checks
        WHERE deployment_id = $1`,
      [deploymentId],
    ),
    db.query(
      `SELECT r.env_key, r.required, b.id IS NOT NULL AS configured
         FROM app_env_requirements r
         LEFT JOIN app_secret_bindings b
           ON b.app_id = r.app_id
          AND b.env_key = r.env_key
          AND b.target_environment = 'production'
        WHERE r.app_id = $1
          AND r.required = true
        ORDER BY r.env_key`,
      [deployment.app_id],
    ),
    db.query(
      `SELECT id, detected_count, scanned_file_count, skipped_file_count, detector_version
         FROM deployment_env_detection_snapshots
        WHERE deployment_id = $1`,
      [deploymentId],
    ),
    db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE severity = 'error')::int AS errors
         FROM deployment_logs
        WHERE deployment_id = $1
          AND source = 'build'`,
      [deploymentId],
    ),
    db.query(
      `SELECT id, operation_type, provider, source_commit_sha, provider_project_id, provider_resource_id, status, updated_at
         FROM deployment_provider_operations
        WHERE deployment_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [deploymentId],
    ),
  ]);

  const requiredEnv = envResult.rows.map((row) => ({
    envKey: row.env_key,
    required: row.required,
    configured: row.configured,
  }));
  const missingEnvKeys = requiredEnv.filter((row) => !row.configured).map((row) => row.envKey);
  const build = buildResult.rows[0] ?? null;
  const lastHealth = healthResult.rows[0] ?? null;
  const logs = logCountResult.rows[0] ?? { total: 0, errors: 0 };
  const operation = operationResult.rows[0] ?? null;
  const snapshot = envSnapshotResult.rows[0] ?? null;

  return {
    deployment: {
      id: deployment.id,
      deploymentKey: deployment.deployment_key,
      appId: deployment.app_id,
      appSlug: deployment.app_slug,
      status: deployment.status,
      sourceCommitSha: deployment.source_commit_sha,
      sourceBranch: deployment.source_branch,
      runtimeProjectId: deployment.runtime_project_id,
      providerDeploymentId: deployment.provider_deployment_id,
      liveUrl: deployment.live_url,
      errorCode: deployment.error_code,
      createdAt: deployment.created_at,
      queuedAt: deployment.queued_at,
      startedAt: deployment.started_at,
      updatedAt: deployment.updated_at,
      finishedAt: deployment.finished_at,
    },
    events: eventResult.rows.map((row) => ({
      id: Number(row.id),
      eventType: row.event_type,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
      createdAt: row.created_at,
    })),
    build: build ? {
      provider: build.provider,
      providerDeploymentId: build.provider_deployment_id,
      providerDeploymentUrl: build.provider_deployment_url,
      sourceCommitSha: build.source_commit_sha,
      status: build.status,
    } : null,
    lastHealthCheck: lastHealth ? {
      attemptNumber: Number(lastHealth.attempt_number),
      status: lastHealth.status,
      httpStatus: numberOrNull(lastHealth.http_status),
      latencyMs: numberOrNull(lastHealth.latency_ms),
      errorCode: lastHealth.error_code,
      checkedAt: lastHealth.checked_at,
    } : null,
    healthAttemptCount: Number(healthCountResult.rows[0].count),
    envRequirementCount: requiredEnv.length,
    missingEnvCount: missingEnvKeys.length,
    missingEnvKeys,
    envSnapshot: snapshot ? {
      id: snapshot.id,
      detectedCount: Number(snapshot.detected_count),
      scannedFileCount: Number(snapshot.scanned_file_count),
      skippedFileCount: Number(snapshot.skipped_file_count),
      detectorVersion: snapshot.detector_version,
    } : null,
    policy: {
      policyTier: deployment.policy_tier,
      maxBuildMinutes: Number(deployment.max_build_minutes),
      maxHealthAttempts: Number(deployment.max_health_attempts),
    },
    buildLogCount: Number(logs.total),
    buildErrorLogCount: Number(logs.errors),
    providerOperation: operation ? {
      id: operation.id,
      operationType: operation.operation_type,
      provider: operation.provider,
      sourceCommitSha: operation.source_commit_sha,
      providerProjectId: operation.provider_project_id,
      providerResourceId: operation.provider_resource_id,
      status: operation.status,
    } : null,
  };
}
