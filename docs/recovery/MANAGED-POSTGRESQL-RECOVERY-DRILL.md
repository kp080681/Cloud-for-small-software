# Managed PostgreSQL Recovery Drill

Status: Node 15R.12B drill tooling debugged after the first disposable provider attempt. A clean operator rerun is still required before managed PostgreSQL recovery can be marked proven. No production control-plane database, customer database, workload, Vercel resource, Trigger worker, or Supabase project is touched by this drill.

## First Disposable Drill Attempt

Observed attempt:

```text
provider: Neon
disposableProjectId: young-art-46917057
result: FAILED_BEFORE_RESTORE
error: Destructive test mutation did not change probe data
cleanupCompleted: true
deleted: true
plaintextDatabaseCredentialsPrinted: false
```

The attempt failed in the drill verifier before restore evidence was collected. Cleanup completed successfully and the disposable provider resource was deleted.

Root cause:

The original mutation deleted row `id=2` and inserted row `id=4`, so the probe digest changed but the row count remained `3`. The verifier required both digest and row count to change. That made the run fail even though the synthetic data had changed. This was a drill-tooling false negative, not evidence of a Neon restore failure, stale reads, or production data mutation.

Corrective change:

- Probe setup, mutation, and summary logic now live in a small deterministic helper.
- The destructive mutation deletes all probe rows, making the post-mutation state unambiguous.
- The digest is computed from freshly queried ordered `id`/`value` rows.
- The verifier checks that mutation and post-mutation verification use the same database identity before restore.
- The LSN is captured after original probe data is written and before destructive mutation.
- The failure path still prints `cleanupRequired=true` when a disposable project exists, without printing credentials.

Current status:

```text
MANAGED_POSTGRESQL_RECOVERY_DRILL_STATUS = CODE_FIXED_PENDING_CLEAN_OPERATOR_RERUN
```

## Recovery Contract

For controlled alpha, SSC-managed PostgreSQL recovery means:

- SSC owns the lifecycle of `SSC_MANAGED` customer PostgreSQL resources.
- SSC relies on Neon/provider-native recovery capabilities for the managed database data plane.
- SSC must prove a disposable recovery path before claiming managed customer database recovery.
- Recovery evidence must use synthetic, non-sensitive data only.
- Recovery observations are engineering evidence, not public RPO/RTO commitments.

This does not promise continuous SSC-managed backups, customer self-service restore, arbitrary PITR UI, zero RPO, zero downtime, or recovery for external databases.

## Provider Mechanism

Current Neon documentation identifies branch restore / point-in-time restore as the appropriate provider-native mechanism. The Neon branch restore API restores a branch to an earlier state using a source LSN or timestamp. When restoring a branch to its own history, Neon requires a `preserve_under_name` value so the current state is retained under a backup branch.

References:

- Neon instant restore / backup and restore: `https://neon.com/docs/postgres/backup-restore/branch-restore`
- Neon history window: `https://neon.com/docs/postgres/backup-restore/history-window`
- Neon branch restore API: `https://api-docs.neon.tech/reference/restoreprojectbranch`
- Neon operations API: `https://api-docs.neon.tech/reference/getprojectoperation`

Current classification:

```text
NEON_RECOVERY_MECHANISM = NEON_BRANCH_RESTORE_TO_LSN
RESTORE_TARGET_MODEL = IN_PLACE_BRANCH_RESTORE_WITH_PRESERVED_BACKUP_BRANCH
CUSTOMER_DATABASE_RECOVERY_STATUS = CODE_READY_PENDING_REAL_DRILL
```

Retention/history window and plan availability remain provider/account-dependent until the operator records live account evidence. Do not treat documentation availability as proof that the current account has the required recovery window.

## Drill Runner

Script:

```text
control-plane/scripts/run-managed-database-recovery-drill.mjs
```

The script is intentionally guarded:

- Requires `NEON_API_KEY`.
- Requires `SSC_MANAGED_DB_RECOVERY_DRILL_CONFIRM=CREATE_DISPOSABLE_NEON_RECOVERY_DRILL`.
- Uses generated disposable workspace/app UUIDs unless explicit disposable IDs are supplied.
- Creates a Neon project using the same deterministic SSC-managed database naming model as Node 15R.12A.
- Writes only synthetic test data.
- Captures an LSN after the original data is written.
- Mutates the synthetic data.
- Restores the branch to the captured LSN.
- Verifies row count and digest parity.
- Prints provider IDs, row counts, digests, timings, and cleanup commands only.
- Never prints `DATABASE_URL`, passwords, Neon token, or raw provider credential payloads.

Run from `control-plane`:

```powershell
$env:SSC_MANAGED_DB_RECOVERY_DRILL_CONFIRM="CREATE_DISPOSABLE_NEON_RECOVERY_DRILL"
node .\scripts\run-managed-database-recovery-drill.mjs
```

Optional disposable identity override:

```powershell
$env:SSC_MANAGED_DB_RECOVERY_DRILL_WORKSPACE_ID="<throwaway-workspace-uuid>"
$env:SSC_MANAGED_DB_RECOVERY_DRILL_APP_ID="<throwaway-app-uuid>"
```

## Test Data

The drill creates:

```text
table: ssc_recovery_probe
rows: alpha, bravo, charlie
```

It records:

- original row count
- original SHA-256 digest of ordered values
- mutated row count
- mutated SHA-256 digest
- recovered row count
- recovered SHA-256 digest

Pass condition:

```text
RECOVERED_ROW_COUNT == ORIGINAL_ROW_COUNT
RECOVERED_DIGEST == ORIGINAL_DIGEST
```

## Expected Safe Output

The successful summary includes:

```json
{
  "result": "SSC_MANAGED_DATABASE_RECOVERY_DRILL_READY_FOR_EVIDENCE_REVIEW",
  "provider": "neon",
  "recoveryMechanism": "NEON_BRANCH_RESTORE_TO_LSN",
  "restoreTargetModel": "IN_PLACE_BRANCH_RESTORE_WITH_PRESERVED_BACKUP_BRANCH",
  "databaseMode": "SSC_MANAGED",
  "originalRowCount": 3,
  "destructiveTestMutationConfirmed": true,
  "recoveryCompleted": true,
  "rowCountParity": true,
  "dataDigestParity": true,
  "recoveryRequiresNewDatabaseUrl": false,
  "recoveredDatabaseUrlEncrypted": "NOT_APPLICABLE",
  "cleanupRequired": true,
  "providerResourcesMutated": "DISPOSABLE_ONLY",
  "productionDatabaseMutated": false,
  "plaintextDatabaseCredentialsPrinted": false
}
```

`recoveredDatabaseUrlEncrypted` is `NOT_APPLICABLE` for this drill because the restore is in-place and uses the same disposable connection string. The production deployment path still encrypts generated `DATABASE_URL` through Node 15R.12A.

## Cleanup

After evidence is captured, delete the disposable Neon project with the cleanup command printed by the drill. The command has this shape:

```powershell
$env:SSC_MANAGED_DB_RECOVERY_DRILL_CLEANUP_CONFIRM="DELETE_DISPOSABLE_NEON_RECOVERY_DRILL_RESOURCE"; $env:SSC_MANAGED_DB_RECOVERY_DRILL_PROJECT_ID="<provider-project-id>"; node .\scripts\run-managed-database-recovery-drill.mjs --cleanup
```

No leftover billable resources should remain after cleanup.

## Failure Handling

The runner must not return a false recovered result when:

- provider project creation fails
- restore operation fails or times out
- recovered database is unreachable
- recovered row count differs
- recovered digest differs
- cleanup is still required

On failure, the runner prints a bounded safe error summary and any available cleanup action. It does not print credentials.

## Provider Checks Deferred To 15R.13

The drill may reveal provider facts, but final provider configuration verification remains separate:

- Neon token scope and whether it can affect unrelated projects.
- Project/resource isolation.
- Recovery/PITR availability in the actual account/plan.
- Retention/history window.
- Delete semantics.
- Cost/quota limits.
- Credential rotation behavior.
- TLS/pooling behavior.
