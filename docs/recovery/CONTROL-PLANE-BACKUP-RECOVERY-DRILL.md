# Control-Plane Backup + Recovery Drill

Status: Node 18 technical evidence complete. The real SSC control-plane backup, disposable Neon restore, metadata parity verification, and read-only functional verification completed successfully. Gate 12 is still not complete because Node 15 provider-scope verification/specialist review and Node 16/17 evidence remain, and the Gate 10/11 dependency path remains authoritative.

Scope: SSC-owned control-plane PostgreSQL state only. Do not restore over the active control-plane database. Do not mutate Vantage Supabase, DealOS Supabase, customer databases, live workloads, or provider runtime resources.

## Backup Responsibility

The repository architecture identifies PostgreSQL as the control-plane system of record and Neon as the current/preferred managed PostgreSQL provider. SSC owns the application-level responsibility to ensure the control-plane database can be restored and reconciled. The database provider owns the underlying backup/PITR mechanics according to the selected plan.

Provider-managed Neon backup/PITR should be preferred where verified in the actual provider account. PostgreSQL `pg_dump` is a second portable recovery mechanism and was proven in this drill against a disposable restore target. Treat provider PITR capability as provider-owned infrastructure evidence, not as a substitute for SSC restore validation.

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

Node 15R.10 corrected the optional decrypt proof path. The functional verifier now calls the production secret helper with the valid `{ appId, name }` argument shape and supports only these safe modes:

- `METADATA_ONLY`: default when no deterministic backup/restore/recovery test secret and expected digest are supplied
- `VERIFIED`: controlled decrypt succeeded for the explicit test secret and its SHA-256 matched the expected digest
- `DIGEST_MISMATCH`: controlled decrypt succeeded but the digest did not match; the verifier exits nonzero and does not print plaintext

Do not attempt decrypt proof against arbitrary production/customer secrets.

## Guarded Local Drill

Prerequisites:

- PostgreSQL CLI tools on PATH: `pg_dump`, `pg_restore`, and preferably `psql`
- `DATABASE_URL` pointing to the active SSC control-plane database
- `RESTORE_DATABASE_URL` pointing to a disposable non-production PostgreSQL database
- `CONFIRM_DISPOSABLE_RESTORE=SSC_DISPOSABLE_RESTORE_TARGET`
- `CONTROL_PLANE_BACKUP_SHA256` set to the SHA-256 printed by the backup script
- `CONTROL_PLANE_RESTORE_TARGET_IDENTITY` set to the password-free identity of the approved disposable restore target, in the form `host=<host>;port=<port>;database=<database>;user=<user>`
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
$env:CONTROL_PLANE_BACKUP_SHA256 = "<sha256 returned by backup script>"
$env:CONTROL_PLANE_RESTORE_TARGET_IDENTITY = "host=<restore host>;port=<restore port>;database=<restore database>;user=<restore user>"
$env:CONFIRM_DISPOSABLE_RESTORE = "SSC_DISPOSABLE_RESTORE_TARGET"
node scripts\restore-control-plane-db-disposable.mjs
```

The restore script refuses to run if:

- `RESTORE_DATABASE_URL` is missing
- `CONTROL_PLANE_BACKUP_FILE` is missing
- `CONTROL_PLANE_BACKUP_SHA256` is missing, malformed, or does not match the backup file
- `CONTROL_PLANE_RESTORE_TARGET_IDENTITY` is missing or does not match the derived password-free identity of `RESTORE_DATABASE_URL`
- confirmation is not exact
- `RESTORE_DATABASE_URL` identifies the same database target as `DATABASE_URL`, including textually different query strings and common Neon pooled/direct endpoint variants
- the backup file does not exist

The restore target identity is intentionally supplied separately from the connection URL so an operator must positively name the disposable target before any restore can begin. It is not a secret and must not include passwords or tokens.

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

Final functional verification uses `verify-restored-control-plane-functional.mjs`, which connects only to `RESTORE_DATABASE_URL`, invokes no Trigger tasks, invokes no providers, writes no database rows, and reuses the production diagnostic/timeline normalization modules.

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node scripts\verify-restored-control-plane-functional.mjs
```

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
- backup SHA-256 is verified before restore
- restore target identity is independently approved before restore
- mandatory schema/table/row-count/constraint verifier failures exit nonzero

## Disaster Model

### A. Worker/process loss only

Expected behavior: Trigger retry and existing idempotency/recovery rules resume or safely no-op. Node 04.18 provider operation ledger, Vercel metadata, build reconciliation, health exhaustion, public verification replay, and terminal replay safety apply.

Manual operator action: rerun the orchestrator or targeted worker only after checking diagnostic/timeline state.

Unrecoverable boundary: none expected for already covered deployment lifecycle states.

### B. Control-plane DB loss with backup available

Expected behavior: restore the latest backup/PITR point into a new control-plane database, reconnect workers after validation, then inspect diagnostics/timeline/orphan detection before mutating provider state.

Manual operator action: restore database, verify schema/row counts/secret metadata, optionally verify KMS decryptability for an explicitly safe test secret, then run read-only diagnostics, timeline, inventory, and orphan detection before any provider mutation.

Unrecoverable boundary: writes after the selected backup/PITR point may be absent and must be reconstructed from provider evidence where possible.

Recovery safety rule: the restored database is evidence to inspect, not permission to mutate providers. Before any provider reconciliation, an operator must run read-only diagnostics, timelines, inventory, and orphan detection. Provider mutation after restore must be fenced by the existing deployment/provider-operation identity checks and should start with the smallest targeted reconciliation path, not broad reruns.

### C. Provider resources still exist but DB restored to an older point

Expected behavior: provider resources are evidence, not control-plane truth. Node 04.18 deployment recovery and Node 04.19 orphan detection help identify deployments/projects that exist remotely but are missing or stale locally.

Manual operator action: run read-only inventory/orphan detection first. Repair only through approved reconciliation paths. Do not blindly recreate or delete provider resources.

Unrecoverable boundary: provider resources without SSC metadata or local lineage may not be safely attributable. Node 04.19 orphan inventory is intentionally bounded to positively SSC-owned resources; foreign or metadata-free provider resources are ignored rather than guessed into SSC ownership.

### D. KMS key unavailable

Expected behavior: encrypted secret ciphertext remains backed up but cannot be decrypted for runtime env application until KMS is restored.

Manual operator action: restore/enable the KMS key and worker IAM permissions, then verify with a disposable test secret.

Unrecoverable boundary: if the KMS key material is permanently gone, existing encrypted app secrets are unrecoverable and must be re-entered by authorized operators/customers.

Environment separation note: backup metadata can prove encrypted rows and KMS identifiers survived the restore, but it cannot prove decryptability in another runtime environment unless the correct KMS key, region, IAM role, and encryption-context permissions are available there. Provider/IAM verification remains required before relying on restored secret injection.

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

Practical V1 target after this drill:

- `PRACTICAL_V1_RPO`: provider-managed Neon PITR/history window where verified; otherwise the latest successful portable `pg_dump`
- `PRACTICAL_V1_RTO`: same-day founder/operator restore for current small control-plane datasets, validated by this drill's 102.078 second disposable restore time plus operator credential/provider checks

Observed engineering timings from this drill, not public SLA commitments:

- `OBSERVED_BACKUP_DURATION = 35.129 seconds`
- `OBSERVED_RESTORE_DURATION = 102.078 seconds`
- `backupBytes = 115107`
- `backupSha256 = 9972987d7a96bff053721c3e00207d4b48e2435c4013ddc5df0bf4edd956ffde`
- `schemaRestored = true`
- `rowCountParity = true`
- `restoredTableCount = 23`

## Deletion Boundary

App deletion is destructive for runtime bindings, encrypted secrets, and provider runtime resources. Restoring an older backup must not automatically resurrect deleted provider resources or cause SSC to recreate them blindly. After any restore from an older point, run read-only diagnostics, inventory, and orphan detection before any mutation.

## Automation Decision

For V1, prefer provider-managed automated backups/PITR as the primary safety net and a small scheduled `pg_dump` only if provider verification or export requirements justify it. Do not build a custom backup platform yet.

Recommended V1 posture:

- provider-managed PITR/backup enabled and verified
- periodic local/off-provider `pg_dump` drill for operational proof
- restore test before external alpha and after material schema/security changes

## Current Drill Result

The real recovery drill completed successfully.

Backup evidence:

- Source: real SSC control-plane PostgreSQL
- Tables reported: 23
- `backupBytes = 115107`
- `backupSha256 = 9972987d7a96bff053721c3e00207d4b48e2435c4013ddc5df0bf4edd956ffde`
- `observedBackupDurationMs = 35129`
- `plaintextSecretsPrinted = false`

Restore evidence:

- Target: separate disposable Neon project
- `observedRestoreDurationMs = 102078`
- Restore completed successfully
- Production provider resources untouched

Parity evidence:

- `schemaRestored = true`
- `rowCountParity = true`
- all current operational control-plane tables matched

Encrypted secret recovery evidence:

- `encrypted_secrets` rows: 12
- complete metadata: 12/12
- plaintext not printed
- recovery verification was metadata-only
- this drill did not perform fresh KMS decrypt verification

Functional restore evidence:

- DealUp deployment `fc494742-a56c-4050-8df0-0a667f32efa7`: `LIVE`, diagnostic `DEPLOYMENT_LIVE`, full timeline reconstructed
- Failed-health deployment `06581b97-14f7-43f4-8254-947d2235efb9`: `FAILED`, diagnostic `HEALTH_CHECK_FAILED`, full timeline reconstructed
- `providerCallsExecuted = false`
- `triggerCallsExecuted = false`
- `databaseWritesExecuted = false`
- `plaintextSecretsPrinted = false`

Node 18 result:

- `CONTROL_PLANE_BACKUP_CREATED = true`
- `DISPOSABLE_RESTORE_COMPLETED = true`
- `SCHEMA_RESTORED = true`
- `ROW_COUNT_PARITY = true`
- `FUNCTIONAL_RECOVERY_VERIFIED = true`
- `SECRET_RECOVERY = METADATA_ONLY`
- `PRODUCTION_STATE_MUTATED = false`
- `PRODUCTION_PROVIDER_RESOURCES_MUTATED = false`
- `PLAINTEXT_SECRETS_PRINTED = false`
- `NODE_18_BACKUP_RECOVERY_PROOF = PASS`
- `NODE_18_TECHNICAL_EVIDENCE_COMPLETE = true`
- `GATE_12_COMPLETE = false`

Node 15R.10 recovery safety corrections:

- `RESTORE_PRODUCTION_EQUIVALENCE_GUARD = RESOLVED_CODE_PENDING_NEW_DRILL`
- `RESTORE_REQUIRES_INDEPENDENT_TARGET_IDENTITY = true`
- `BACKUP_DIGEST_VERIFIED_BEFORE_RESTORE = true`
- `RESTORED_SECRET_DECRYPT_CALL = VALID`
- `SECRET_RECOVERY_MODES = METADATA_ONLY | VERIFIED | DIGEST_MISMATCH`
- `REQUIRED_SCHEMA_VERIFICATION = REQUIRED_TABLES_AND_COLUMNS_AND_UNIQUE_CONSTRAINTS`
- `MANDATORY_VERIFICATION_FAILURE_EXITS_NONZERO = true`
- `ORPHAN_INVENTORY_LIMITATION_DOCUMENTED = true`
- `KMS_ENVIRONMENT_SEPARATION_PROVIDER_VERIFY_REQUIRED = true`
- `NEW_REAL_DISPOSABLE_RESTORE_DRILL_REQUIRED = true`

The real Node 18 drill remains valid for backup, restore, parity, functional timeline/diagnostic recovery, and metadata-only secret recovery. A new disposable restore drill is required to prove the stricter Node 15R.10 guard against live infrastructure.

## Cleanup

The local `control-plane/.ssc-backups/` directory contains real control-plane backup data, including encrypted secret material. It is gitignored and must not be committed.

After review, the operator may remove the local backup artifact with:

```powershell
Remove-Item -Recurse -Force ".\control-plane\.ssc-backups"
```

The disposable Neon restore project contains restored production control-plane metadata and should be deleted manually after the drill evidence is accepted.
