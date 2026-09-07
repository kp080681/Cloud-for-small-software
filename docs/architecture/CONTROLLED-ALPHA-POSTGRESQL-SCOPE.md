# Controlled Alpha PostgreSQL Scope

Status: Node 15R.12A implementation complete with PRE_15R_14 live managed PostgreSQL activation proof. This document records the production PostgreSQL scope decision and the smallest managed PostgreSQL production wiring for controlled alpha.

## Boundary

Small Software Cloud has two distinct PostgreSQL responsibilities:

- Control-plane PostgreSQL: SSC's own system-of-record database for workspaces, apps, deployments, secrets metadata, events, recovery evidence, diagnostics, timelines, and inventory.
- Customer workload PostgreSQL: a database used by a deployed customer application through workload configuration such as `DATABASE_URL`.

Node 15R.12 concerns only customer workload PostgreSQL. Node 18 backup/recovery evidence covers the control-plane database and must not be treated as customer database backup evidence.

## Current Customer PostgreSQL Capability

| Capability | Status | Evidence |
| --- | --- | --- |
| Database requirement detection | `PRODUCTION_WIRED` | `control-plane/src/project-detection.mjs` detects PostgreSQL/Supabase-related dependencies and sets `databaseRequired`. |
| Environment requirement detection for `DATABASE_URL` | `PRODUCTION_WIRED` | Source-aware env detection records observed env references; required verification blocks only known-required config before provisioning. |
| Encrypted customer database credentials | `PRODUCTION_WIRED` | Existing app secret path stores workload credentials encrypted and injects them as runtime env bindings. |
| Runtime env binding | `PRODUCTION_WIRED` | `control-plane/trigger/apply-runtime-env.ts` applies app secret bindings to the production runtime environment. |
| PostgreSQL provider abstraction | `PRODUCTION_WIRED` | `control-plane/src/neon-managed-postgres.mjs` contains the bounded Neon API adapter used by the production provisioning/deletion paths. |
| Neon project/database creation | `PRODUCTION_WIRED` | `control-plane/trigger/provision-database.ts` records intent, reconciles by deterministic SSC identity, creates Neon only after claim, and stores provider identity. |
| SSC-generated `DATABASE_URL` for customer apps | `PRODUCTION_WIRED` | Managed provisioning obtains a provider connection URI, enforces TLS query parameters, encrypts it through the app secret path, and binds `DATABASE_URL` to production. |
| Customer database deployment association | `PRODUCTION_WIRED` | `control-plane/db/016_managed_customer_databases.sql` adds explicit app database mode, provider identity, reconciliation key, status, and secret association. |
| Customer database inventory | `PRODUCTION_WIRED` | `control-plane/scripts/list-app-inventory.mjs` includes managed database mode/provider/status fields. |
| Customer database deletion | `PRODUCTION_WIRED` | `control-plane/trigger/delete-app.ts` calls ownership-aware managed DB deletion; `EXTERNAL`/`NONE` skip provider deletion and `UNKNOWN` fails closed. |
| Customer database retry/idempotency | `PRODUCTION_WIRED` | `app_databases` intent/status plus deterministic reconciliation key prevent duplicate create on replay and allow retry/reconcile. |
| Customer database orphan reconciliation | `PARTIALLY_PRODUCTION_WIRED` | `control-plane/trigger/detect-orphan-resources.ts` can read-only classify SSC-looking Neon projects when a Neon token is present; live provider-wide completeness remains 15R.13. |
| Customer database backup/restore proof | `PROVIDER_NATIVE_RECOVERY_VERIFIED` | Node 15R.12B restored a disposable SSC-managed Neon PostgreSQL database to a captured LSN using Neon branch restore and verified exact row-count/digest parity. External customer database backups remain externally owned. |
| Customer database resource limits | `PRODUCTION_WIRED` | Workspace policy now includes `max_managed_databases` with controlled-alpha default `3`; provider storage/compute/spend controls remain provider-verification items. |
| Customer database tenant ownership | `PRODUCTION_WIRED` | Managed DB records bind workspace/app/provider identity and deletion/provisioning helpers assert ownership before mutation. |
| External database configuration diagnostics | `PRODUCTION_WIRED` | Missing required `DATABASE_URL` or Supabase env names can produce actionable environment diagnostics. |
| SSC-managed database lifecycle diagnostics | `PRODUCTION_WIRED` | Managed provisioning records safe database lifecycle events and failure/reconciliation evidence without plaintext connection strings. |
| Customer database audit events | `PRODUCTION_WIRED` | Provisioning records `DATABASE_PROVISIONING`, `DATABASE_READY`, `DATABASE_PROVISIONING_FAILED`, and `DATABASE_RECONCILIATION_REQUIRED`; deletion records durable resource status. |

Conclusion:

```text
CUSTOMER_POSTGRESQL_PROVISIONING = LIVE_ACTIVATION_PASS
```

SSC can safely deploy no-database workloads, workloads that bring an existing external PostgreSQL/Supabase database through encrypted configuration, and explicitly `SSC_MANAGED` PostgreSQL workloads through the managed Neon production path. PRE_15R_14 verified this path with a disposable SSC Recovery Test deployment.

## Workload Database Modes

| Workload | Mode | Evidence |
| --- | --- | --- |
| DealUp website | `NO_DATABASE` | Readiness/deployment evidence found no required env vars and no database requirement for the static/Next.js website workload. |
| Vantage | `EXTERNAL_DATABASE` | Vantage uses existing external Supabase configuration; SSC deployment reuses supplied environment secrets and must not mutate Supabase. |
| DealOS | `EXTERNAL_DATABASE` | DealOS uses production-capable external Supabase data and auth; operational migration is deferred for production safety. |

## Options Evaluated

### Option A - External Database Only For Alpha

SSC would detect database requirements, require founder/customer-supplied `DATABASE_URL` or provider-specific Supabase env secrets, store those as encrypted app secrets, and inject them into the production workload runtime. SSC would not provision Neon for customer workloads during alpha.

This is the smallest operational model for the existing DealUp, Vantage, and DealOS workload set. It is also a real narrowing of the V1 promise because a database-backed ordinary app would still need database creation outside SSC.

### Option B - SSC-Managed PostgreSQL For Alpha

SSC would provision a per-app managed PostgreSQL database, generate credentials, store the connection secret encrypted, inject it only into the production workload runtime, track provider identity, enforce workspace database limits, include database resources in inventory/orphan recovery, and delete only SSC-owned databases through a fenced/idempotent lifecycle.

This is closest to the V1 thesis, but it does not cover current applications that intentionally use existing Supabase Auth/RLS/PostgREST projects.

### Option C - Both Explicit Ownership Modes

SSC records database ownership explicitly:

- `EXTERNAL`: SSC may store and inject encrypted credentials, but it never deletes or mutates the external database.
- `SSC_MANAGED`: SSC owns provider identity, lifecycle, reconciliation, backup responsibility evidence, and safe deletion boundaries.
- `UNKNOWN`: destructive database operations fail closed.

This is the selected model. It preserves current real-workload safety while keeping the V1 PostgreSQL thesis intact. It also prevents SSC from inferring ownership later from the mere presence of `DATABASE_URL`.

## Selected Controlled Alpha Model

```text
SELECTED_ALPHA_POSTGRESQL_MODEL = BOTH_EXPLICIT_OWNERSHIP_MODES
```

For controlled alpha:

- No-database workloads are supported.
- Existing external PostgreSQL/Supabase workloads are supported through encrypted app secrets and normal env requirement verification.
- SSC must not delete, modify, migrate, back up, or restore external customer databases.
- SSC-managed PostgreSQL is now production-wired in code and schema, and PRE_15R_14 live activation verified provisioning/reconciliation on a disposable workload.
- Managed customer database backup/restore proof for the tested Neon branch-restore-to-LSN path is complete under `15R.12B Managed PostgreSQL Recovery Proof`.

This does not remove PostgreSQL from the V1 thesis. It also prevents the platform from inferring ownership from `DATABASE_URL` or provider hostnames.

## Implemented 15R.12A Scope

Node 15R.12A implements:

- Add explicit database ownership/mode: `NONE`, `EXTERNAL`, `SSC_MANAGED`, and fail-closed unknown/null behavior for destructive DB operations.
- Keep deletion semantics ownership-aware: SSC never deletes `EXTERNAL`; `SSC_MANAGED` deletion requires provider identity; `UNKNOWN` refuses destructive database operations.
- Provision one isolated managed PostgreSQL database per app when required and requested as `SSC_MANAGED`.
- Persist provider database identity, branch/endpoint/database/role metadata, ownership, workspace/app/deployment association, and lifecycle status.
- Generate and encrypt the workload connection string without printing plaintext.
- Bind the generated connection secret as production-only runtime configuration.
- Add idempotent create/reconcile/delete behavior backed by provider-operation intent or equivalent fenced state.
- Add workspace database admission limit `max_managed_databases` with default `3`.
- Extend inventory/orphan detection to SSC-owned database resources.
- Add audit events and diagnostics for managed database create/reconcile/delete/failure states.
- Document provider backup/PITR responsibility and the completed disposable customer database restore proof from Node 15R.12B.
- Record live Neon token scope, backup/PITR, quota, and cost controls as provider-dependent verification items.

## Current Safe Destructive Boundary

The current production delete flow must be treated as safe for external databases because no production customer database deletion path exists. It may remove encrypted SSC-held workload secrets, which revokes SSC's copy of the credential, but it does not delete the external provider database.

Managed database deletion is fail-closed:

- `EXTERNAL`: never delete provider DB.
- `SSC_MANAGED`: delete only when provider identity and tenant ownership match the persisted SSC record and provider evidence.
- `UNKNOWN`: refuse destructive operation and require explicit recovery classification.

## Backup And Recovery Responsibility

External database mode:

- Customer/founder/provider owns database backups, PITR, migrations, RLS/Auth configuration, and recovery drills.
- SSC owns encrypted storage of supplied credentials and deployment diagnostics for missing required configuration.

SSC-managed database mode:

- SSC must verify provider-managed backup/PITR and prove at least one customer database restore path before claiming backup coverage.
- Control-plane backup evidence does not prove customer database recovery.

Node 15R.12B proved the managed database recovery drill around Neon branch restore to an LSN using a disposable project and synthetic data. The drill restored row-count and SHA-256 digest parity after destructive mutation, printed no plaintext database credentials, and cleaned up the disposable Neon project.

```text
PROVIDER_NATIVE_RECOVERY_VERIFIED = true
SSC_MANAGED_DATABASE_RECOVERY_STATUS = PASS
CUSTOMER_DATABASE_RECOVERY_STATUS = PASS
NODE_15R_12B_COMPLETE = true
```

The proven claim remains narrow: a disposable SSC-managed Neon PostgreSQL database was restored to a previously captured LSN using Neon branch restore, and deterministic test data was recovered with exact row-count and digest parity. This does not claim zero data loss generally, guaranteed RPO/RTO, customer self-service restore, scheduled SSC backups, or coverage for all Neon recovery mechanisms.

## Provider-Dependent Security Checks

Provider-dependent items that remain important for independent review and later public/self-service hardening:

- Neon organization/project/token scope and least-privilege practical boundary.
- Per-app database isolation and tenant identity mapping.
- Project/database deletion semantics and recovery window.
- Backup/PITR availability for the selected plan.
- Connection TLS/pooling behavior and credential rotation path.
- Workspace-level managed database count, storage, compute, and spend guardrails.
- Orphan/recovery behavior when SSC state is restored behind existing provider database resources.

PRE_15R_14 live activation result:

```text
deploymentId = 7177b871-2c70-4afd-bd12-bab6fedfaed2
appId = 6bc015df-ccb1-4151-982e-3ea24e45c54b
workspaceId = 1527483e-69a3-4771-9bf1-b54a70028d9e
databaseMode = SSC_MANAGED
deploymentStatus = PROVISIONING
databaseStatus = READY
providerProjectId = patient-tooth-74331988
providerProjectName = ssc-6bc015dfccb1-408986212cc5-db
connectionSecretId = f3f828ef-fc1a-4079-88d0-482bf9e1a6d0
duplicateNeonProjectsCreated = 0
plaintextDatabaseUriPrinted = false
```

The proof intentionally stopped short of claiming the disposable application reached `LIVE`. The Neon project was not deleted as part of the evidence recording.

## Neon Spike Audit

Spike files:

- `docs/03-architecture-spike/SPIKE-C-RESULTS.md`
- `docs/03-architecture-spike/SPIKE-PLAN.md`
- `docs/03-architecture-spike/ARCHITECTURE-DECISIONS.md`

Spike provider API:

- Create Neon project through the Neon API.
- Obtain pooled PostgreSQL connection URI.
- Delete the disposable Neon project after verification.

Spike resource model:

- One disposable Neon project/database for the test app.
- Provider IDs were observed and the resource was deleted after the spike.

Spike credential model:

- Connection URI was injected into runtime env as `DATABASE_URL`.
- The URI was not printed, but full production KMS envelope encryption was deferred to Spike E.

Spike create flow:

```text
Create Neon project
-> obtain pooled connection URI
-> create Vercel runtime
-> inject DATABASE_URL
-> deploy app
-> verify application read/write
```

Spike delete flow:

```text
delete Vercel runtime
-> delete Neon project
```

Spike retry behavior:

- Provider interaction was proven manually at spike level.
- Durable intent, replay convergence, and ambiguous-resource handling were not production-wired until Node 15R.12A.

Spike identity evidence:

- Provider project/database metadata was observed.
- Durable workspace/app identity was not part of the production control-plane lifecycle in the spike.

Spike security gaps closed by 15R.12A:

- Explicit ownership mode.
- Deterministic workspace/app-based provider name and reconciliation key.
- Provider create intent before external create call.
- Encrypted generated `DATABASE_URL` through the existing KMS secret path.
- Production-only runtime secret binding.
- Ownership-aware deletion and fail-closed unknown mode.
- Workspace managed database admission limit.

Remaining provider-dependent gaps:

- Live Neon token scope and account permissions.
- Provider backup/PITR account/plan settings beyond the tested disposable branch-restore path.
- Project/storage/compute/spend limits.
- Live provider orphan inventory completeness.
