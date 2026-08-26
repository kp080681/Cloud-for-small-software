# Spike C - Managed PostgreSQL Results

## Status

**PASS**

## Purpose

Spike C validated that Small Software Cloud can provision a PostgreSQL database programmatically, bind it to a deployed Next.js application without printing the connection URI, verify real read/write behaviour, and clean up both runtime and database resources.

## Test revision

```text
Repository: kp080681/Cloud-for-small-software
Branch: main
Commit: db962946a67fdec0351446e787cc0645a170ef59
```

## Result summary

Observed result:

```text
SPIKE_C_PASS
```

The tested chain was:

```text
Create Neon project by API
  -> reconcile created database
  -> obtain pooled connection binding
  -> create Vercel runtime
  -> configure protected health access
  -> inject APP_BUILD_MARKER
  -> inject DATABASE_URL
  -> deploy pinned commit
  -> application creates/writes/reads database record
  -> health endpoint confirms read-write verification
  -> delete runtime
  -> delete database
```

## Provider resources

Successful test resource IDs:

```text
Neon project: damp-field-51064261
Vercel project: prj_UzTusoJT3I3hiELUhFDGBdkh6edN
Vercel deployment: dpl_9osMGRidwv4ajQRh2qspUjMKP25P
```

The resources were deleted after verification.

## Database binding

Observed non-secret binding metadata:

```text
branchId: br-flat-butterfly-aywdecrx
endpointId: ep-weathered-moon-aynkxsf4
databaseName: neondb
roleName: neondb_owner
connectionUriPrinted: false
```

### Finding

The platform can obtain a usable pooled PostgreSQL connection string programmatically and bind it to a runtime without serializing the URI into normal result output.

Full envelope encryption is deferred to Spike E; this test validates provider/runtime plumbing, not final secret-storage architecture.

## Runtime health result

The deployed application returned:

```json
{
  "ok": true,
  "service": "ssc-spike-c-test-app",
  "marker": "spike-c-1787715354633",
  "database": "read-write-verified"
}
```

### Finding

The application did not merely establish a TCP/database connection.

It performed a real database write and subsequent read through the injected `DATABASE_URL`, and the health verifier confirmed the expected marker.

## Timings

Measured successful run:

```text
Database provisioning          3.777 s
Runtime provisioning           3.673 s
Configuration                  0.737 s
Build + deployment            34.719 s
DB read/write verification     2.175 s
```

Total from start of database provisioning to completed application/database verification:

```text
~45.1 seconds
```

This is a baseline only. No optimization has been attempted.

## Cleanup

Runtime cleanup:

```text
deleted = true
alreadyAbsent = false
```

Database cleanup:

```text
deleted = true
alreadyAbsent = false
```

### Finding

Both resource classes can be torn down programmatically after the test.

Repeated/idempotent database deletion should be added to later provider contract tests, analogous to the runtime deletion behaviour already proven in Spike B.

## Failed attempts and findings

### Attempt 1 - Missing Neon organization context

Neon returned:

```text
org_id is required
```

This exposed a real current API requirement for the account/key mode used during the spike.

The provider adapter was updated to supply explicit organization context.

### Attempt 2 - Organization context still not recognized

The adapter was changed to provide the Neon organization ID in both query context and the project creation payload.

This removed reliance on account inference and allowed project creation to proceed.

### Attempt 3 - Missing Vercel token in local shell

Neon provisioning succeeded in 3.879 seconds, proving the database path, but runtime provisioning stopped before provider mutation because `VERCEL_TOKEN` was absent from that PowerShell session.

This was an operator-environment issue rather than architecture failure.

The earlier Neon project from that interrupted attempt was explicitly cleaned up before continuing.

## Acceptance criteria status

### Database created programmatically

PASS.

### Provider resource ID persisted/available for reconciliation

PASS at spike level through returned/stored Neon project ID and follow-up lookup.

Durable control-plane persistence remains for later implementation.

### Connection credential handled through secret path

PARTIAL PASS.

The credential was retrieved programmatically, injected into Vercel as an encrypted environment variable, and never printed in result output.

Final KMS-backed persistence/decryption is intentionally deferred to Spike E.

### Application receives its own database credential

PASS for the single-workload spike.

Cross-tenant enforcement requires production tenant/resource tests later.

### App successfully reads/writes PostgreSQL

PASS.

Health result explicitly reported `database = read-write-verified`.

### Database survives failed redeploy

NOT YET EXERCISED in this spike run.

Architecture ownership is application-scoped, but an explicit failed-redeploy preservation test should be included when persisted deployment/application resources exist.

### Database deletion only through explicit resource lifecycle

PASS for the spike runner: database was not tied to deployment deletion and was explicitly deleted as a separate resource.

### Provider timeout/retry reconciliation

PARTIAL.

Create + subsequent lookup reconciliation is proven at the basic provider-contract level. Timeout-after-success simulation remains for later durable provider-operation testing.

## Architecture conclusions

Spike C validates the core `PostgresProvider` direction for Neon:

```text
createDatabase()
getDatabase()
getConnectionBinding()
deleteDatabase()
```

It also validates a critical Small Software Cloud product behaviour:

> A supported database-backed application can receive a newly provisioned PostgreSQL database and become live without a human creating or wiring the database in a provider dashboard.

## Node 03 checkpoint

```text
Spike A - Runtime-only gold path                 PASS
Spike B - Failure/idempotency/cleanup            PASS
Spike C - Managed PostgreSQL                     PASS
Spike D - Durable Trigger.dev execution          NEXT
Spike E - AWS KMS secret handling                PENDING
Spike F - GitHub App integration                 PENDING
```

## Decision

Spike C is accepted as passed for its stated scope.

Proceed to Spike D - Durable background execution, where deployment truth must survive asynchronous task execution/retry while PostgreSQL remains canonical state.
