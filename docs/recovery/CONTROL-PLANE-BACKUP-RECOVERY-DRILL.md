# Control-Plane Backup + Recovery Drill

Status: Node 18 drill runbook and guarded scripts. The drill was not completed in the Codex session that created this document because `DATABASE_URL`, `RESTORE_DATABASE_URL`, KMS env, `pg_dump`, `pg_restore`, and `psql` were not available on PATH/in the shell. Do not mark Node 18 complete until the disposable restore proof below has been run and recorded.

Scope: SSC-owned control-plane PostgreSQL state only. Do not restore over the active control-plane database. Do not mutate Vantage Supabase, DealOS Supabase, customer databases, live workloads, or provider runtime resources.

## Backup Responsibility

The repository architecture identifies PostgreSQL as the control-plane system of record and Neon as the current/preferred managed PostgreSQL provider. SSC owns the application-level responsibility to ensure the control-plane database can be restored and reconciled. The database provider owns the underlying backup/PITR mechanics according to the selected plan.

Current provider-level backup status must be verified in the actual provider account. Neon documentation describes instant restore / point-in-time restore within a configured history window, plus snapshot/backup workflows and pg_dump automation guidance. Treat that as provider capability, not as proof that the SSC production project is configured correctly.

## Backup Scope

The backup must include all public schema objects, indexes, constraints, and migration-applied schema state from:

- `workspaces`
- `github_installations`
- `github_repositories`
- `apps`
- `deployments`, including redeployment lineage columns
- `deployment_events`
- `encrypted_secrets`
- `app_databases`
- `app_secret_bindings`
- `deployment_secret_applications`
- `app_runtimes`
- `deployment_build_inputs`
- `deployment_builds`
- `deployment_health_checks`
- `deployment_logs`
- `app_deletions`
- `app_resource_policies`
- `deployment_env_detection_snapshots`
- `deployment_env_requirement_detections`
- `deployment_provider_operations`

The current repository migrations are `control-plane/db/001_initial_schema.sql` through `control-plane/db/013_provider_operations.sql`. No separate migration tracking table is present in the repository schema, so schema/version verification is currently by restored object structure plus migration file inventory.

## Secret Backup Model

Encrypted app secrets may be backed up as ciphertext. Backup and restore verification must never decrypt arbitrary production secrets or print plaintext values.

Restored `encrypted_secrets` rows must preserve:

- `ciphertext`
- `encrypted_data_key`
- `iv`
- `auth_tag`
- `kms_key_id`
- `encryption_context`
- workspace/app/name metadata

Restored ciphertext remains decryptable only if the same KMS key and encryption context remain available. If a decrypt proof is needed, use an explicitly disposable SSC test secret in a disposable restored database and return only a boolean/hash comparison result, never plaintext.

## Guarded Local Drill

Prerequisites:

- PostgreSQL CLI tools on PATH: `pg_dump`, `pg_restore`, and preferably `psql`
- `DATABASE_URL` pointing to the active SSC control-plane database
- `RESTORE_DATABASE_URL` pointing to a disposable non-production PostgreSQL database
- `CONFIRM_DISPOSABLE_RESTORE=SSC_DISPOSABLE_RESTORE_TARGET`
- Optional `CONTROL_PLANE_BACKUP_DIR`, defaulting to `control-plane/.ssc-backups`

Create a local disposable backup:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node scripts\backup-control-plane-db.mjs
```

Expected safe output:

- backup file path
- backup byte size
- backup SHA-256
- table count
- table names
- observed backup duration
- `plaintextSecretsPrinted: false`

Restore into the disposable target only:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
$env:CONTROL_PLANE_BACKUP_FILE = "<path returned by backup script>"
$env:CONFIRM_DISPOSABLE_RESTORE = "SSC_DISPOSABLE_RESTORE_TARGET"
node scripts\restore-control-plane-db-disposable.mjs
```

The restore script refuses to run if:

- `RESTORE_DATABASE_URL` is missing
- `CONTROL_PLANE_BACKUP_FILE` is missing
- confirmation is not exact
- `RESTORE_DATABASE_URL` exactly matches `DATABASE_URL`
- the backup file does not exist

Verify source/restored metadata parity:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node scripts\verify-control-plane-restore.mjs
```

Expected safe output:

- schema restored boolean
- row-count parity boolean
- table count
- per-table row counts and existence only
- restored encrypted-secret metadata completeness
- `plaintextPrinted: false`
- `decrypted: false`

The scripts do not run deployment diagnostics/timeline automatically because the current diagnostic and timeline runners enqueue Trigger tasks. For a strict read-only restore proof, either point those runners at an isolated Trigger environment backed by the disposable restored DB or add a direct read-only diagnostic/timeline runner in a separate approved node.

## Consistency Checks

Minimum successful proof:

- backup file created from the control-plane DB
- restore completes into disposable DB
- all expected public tables exist in the restored DB
- row counts match for important tables
- `encrypted_secrets` metadata fields are complete after restore
- app/runtime/build/deployment/provider-operation rows remain joinable by IDs
- no plaintext secret values are printed
- no provider resources are created, deleted, or modified

## Disaster Model

### A. Worker/process loss only

Expected behavior: Trigger retry and existing idempotency/recovery rules resume or safely no-op. Node 04.18 provider operation ledger, Vercel metadata, build reconciliation, health exhaustion, public verification replay, and terminal replay safety apply.

Manual operator action: rerun the orchestrator or targeted worker only after checking diagnostic/timeline state.

Unrecoverable boundary: none expected for already covered deployment lifecycle states.

### B. Control-plane DB loss with backup available

Expected behavior: restore the latest backup/PITR point into a new control-plane database, reconnect workers after validation, then inspect diagnostics/timeline/orphan detection before mutating provider state.

Manual operator action: restore database, verify schema/row counts/secret metadata, verify KMS decryptability for an explicitly safe test secret, then run read-only inventory/orphan detection.

Unrecoverable boundary: writes after the selected backup/PITR point may be absent and must be reconstructed from provider evidence where possible.

### C. Provider resources still exist but DB restored to an older point

Expected behavior: provider resources are evidence, not control-plane truth. Node 04.18 deployment recovery and Node 04.19 orphan detection help identify deployments/projects that exist remotely but are missing or stale locally.

Manual operator action: run read-only inventory/orphan detection first. Repair only through approved reconciliation paths. Do not blindly recreate or delete provider resources.

Unrecoverable boundary: provider resources without SSC metadata or local lineage may not be safely attributable.

### D. KMS key unavailable

Expected behavior: encrypted secret ciphertext remains backed up but cannot be decrypted for runtime env application until KMS is restored.

Manual operator action: restore/enable the KMS key and worker IAM permissions, then verify with a disposable test secret.

Unrecoverable boundary: if the KMS key material is permanently gone, existing encrypted app secrets are unrecoverable and must be re-entered by authorized operators/customers.

### E. Trigger state unavailable

Expected behavior: durable control-plane truth remains in PostgreSQL. Active external Trigger run state may be lost, but workers should resume from database state and provider evidence.

Manual operator action: redeploy/reconnect Trigger workers, then rerun orchestrator or targeted recovery tasks after inspecting diagnostics/timeline.

Unrecoverable boundary: in-flight provider side effects not yet recorded locally rely on Node 04.18 provider metadata/ledger recovery where available.

### F. Provider token rotated

Expected behavior: database state remains intact, but provider reconciliation/build/delete/log tasks fail until the new token is configured.

Manual operator action: configure the replacement token in the control-plane environment, verify least privilege, then rerun read-only diagnostics or recovery tasks.

Unrecoverable boundary: none if provider account/resource access is retained.

## RPO / RTO

Do not present these as customer SLAs. They are internal engineering targets.

Current practical V1 target before drill:

- `PRACTICAL_V1_RPO`: provider PITR/history window if verified, otherwise last successful pg_dump
- `PRACTICAL_V1_RTO`: same-day founder/operator restore for small control-plane datasets after credentials and disposable restore validation are available

Record actual values after the drill:

- `OBSERVED_BACKUP_DURATION`
- `OBSERVED_RESTORE_DURATION`
- restored database size/table count
- source/restored row-count parity

## Deletion Boundary

App deletion is destructive for runtime bindings, encrypted secrets, and provider runtime resources. Restoring an older backup must not automatically resurrect deleted provider resources or cause SSC to recreate them blindly. After any restore from an older point, run read-only diagnostics, inventory, and orphan detection before any mutation.

## Automation Decision

For V1, prefer provider-managed automated backups/PITR as the primary safety net and a small scheduled `pg_dump` only if provider verification or export requirements justify it. Do not build a custom backup platform yet.

Recommended V1 posture:

- provider-managed PITR/backup enabled and verified
- periodic local/off-provider `pg_dump` drill for operational proof
- restore test before external alpha and after material schema/security changes

## Current Drill Result

This Codex session did not create a backup or restore because required connection env and PostgreSQL CLI tooling were unavailable:

- `DATABASE_URL = MISSING`
- `RESTORE_DATABASE_URL = MISSING`
- `AWS_REGION = MISSING`
- `AWS_KMS_KEY_ID = MISSING`
- `pg_dump` not found on PATH
- `pg_restore` not found on PATH
- `psql` not found on PATH

Current result:

- `CONTROL_PLANE_BACKUP_CREATED = false`
- `DISPOSABLE_RESTORE_COMPLETED = false`
- `SCHEMA_RESTORED = false`
- `ROW_COUNT_PARITY = false`
- `DIAGNOSTIC_READ_FROM_RESTORED_DB = false`
- `TIMELINE_READ_FROM_RESTORED_DB = false`
- `SECRET_RECOVERY_VERIFIED = false`
- `NODE_18_BACKUP_RECOVERY_PROOF = PARTIAL`
