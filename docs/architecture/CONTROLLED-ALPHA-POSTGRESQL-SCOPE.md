# Controlled Alpha PostgreSQL Scope

Status: Node 15R.12 decision complete. This document records the production PostgreSQL scope decision for controlled alpha. No provider resources, databases, migrations, Trigger workers, customer workloads, or secrets were changed for this node.

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
| PostgreSQL provider abstraction | `SPIKE_ONLY` | Spike C proved the `PostgresProvider` direction, but no active production lifecycle task provisions customer databases. |
| Neon project/database creation | `SPIKE_ONLY` | `docs/03-architecture-spike/SPIKE-C-RESULTS.md` proved disposable Neon provisioning and cleanup outside the current production lifecycle. |
| SSC-generated `DATABASE_URL` for customer apps | `SPIKE_ONLY` | Spike C obtained and bound a pooled Neon connection URI; production code currently relies on supplied encrypted app secrets. |
| Customer database deployment association | `DOCUMENTED_ONLY` | `app_databases` exists as a placeholder schema table, but ownership/mode/lifecycle semantics are not production-wired. |
| Customer database inventory | `ABSENT` | Current inventory traces apps, runtimes, builds, env bindings, and provider deployments, not managed customer databases. |
| Customer database deletion | `ABSENT` | Production delete flow deletes SSC runtime resources and app secrets; it does not own or delete customer databases. |
| Customer database retry/idempotency | `ABSENT` | Provider-operation ledger covers runtime/build operations, not managed database create/delete operations. |
| Customer database orphan reconciliation | `ABSENT` | Orphan detection is currently implemented for SSC-owned Vercel resources, not managed database resources. |
| Customer database backup/restore proof | `ABSENT` | Node 18 proves control-plane backup/restore only. External customer database backups remain externally owned. |
| Customer database resource limits | `ABSENT` | Workspace economic guardrails do not yet include managed database count/storage/compute limits. |
| Customer database tenant ownership | `DOCUMENTED_ONLY` | Placeholder schema has workspace/app columns, but production ownership enforcement is not wired. |
| External database configuration diagnostics | `PRODUCTION_WIRED` | Missing required `DATABASE_URL` or Supabase env names can produce actionable environment diagnostics. |
| SSC-managed database lifecycle diagnostics | `ABSENT` | Managed database create/reconcile/delete/failure diagnostics do not exist yet. |
| Customer database audit events | `ABSENT` | No production managed database create/delete/reconcile events exist. |

Conclusion:

```text
CUSTOMER_POSTGRESQL_PROVISIONING = SPIKE_ONLY
```

SSC can safely deploy no-database workloads and workloads that bring an existing external PostgreSQL/Supabase database through encrypted configuration. SSC cannot yet honestly claim production lifecycle ownership of customer PostgreSQL provisioning.

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
- SSC-managed PostgreSQL is not implemented in the production lifecycle yet.
- A dedicated `15R.12A Production PostgreSQL Provisioning` node is required before SSC claims managed customer PostgreSQL support for database-backed alpha workloads.

This does not remove PostgreSQL from the V1 thesis. It prevents the platform from overstating a spike as a production capability.

## Required 15R.12A Scope

The smallest implementation that would satisfy SSC-managed PostgreSQL for V1 is:

- Add explicit database ownership/mode: `EXTERNAL`, `SSC_MANAGED`, and fail-closed `UNKNOWN`.
- Keep deletion semantics ownership-aware: SSC never deletes `EXTERNAL`; `SSC_MANAGED` deletion requires provider identity; `UNKNOWN` refuses destructive database operations.
- Provision one isolated managed PostgreSQL database per app when required and requested as `SSC_MANAGED`.
- Persist provider database identity, branch/endpoint/database/role metadata, ownership, workspace/app/deployment association, and lifecycle status.
- Generate and encrypt the workload connection string without printing plaintext.
- Bind the generated connection secret as production-only runtime configuration.
- Add idempotent create/reconcile/delete behavior backed by provider-operation intent or equivalent fenced state.
- Add workspace database admission limits such as maximum SSC-managed databases per workspace.
- Extend inventory/orphan detection to SSC-owned database resources.
- Add audit events and diagnostics for managed database create/reconcile/delete/failure states.
- Document provider backup/PITR responsibility and run a separate restore proof for SSC-managed customer database recovery.
- Verify Neon provider API semantics, token scope, delete behavior, backup/PITR availability, project quotas, and cost controls before live use.

## Current Safe Destructive Boundary

The current production delete flow must be treated as safe for external databases because no production customer database deletion path exists. It may remove encrypted SSC-held workload secrets, which revokes SSC's copy of the credential, but it does not delete the external provider database.

Future managed database deletion must be fail-closed:

- `EXTERNAL`: never delete provider DB.
- `SSC_MANAGED`: delete only when provider identity and tenant ownership match the persisted SSC record.
- `UNKNOWN`: refuse destructive operation and require explicit recovery classification.

## Backup Responsibility

External database mode:

- Customer/founder/provider owns database backups, PITR, migrations, RLS/Auth configuration, and recovery drills.
- SSC owns encrypted storage of supplied credentials and deployment diagnostics for missing required configuration.

SSC-managed database mode:

- SSC must verify provider-managed backup/PITR and prove at least one customer database restore path before claiming backup coverage.
- Control-plane backup evidence does not prove customer database recovery.

## Provider-Dependent Security Checks

Before `SSC_MANAGED` customer PostgreSQL goes live, verify:

- Neon organization/project/token scope and least-privilege practical boundary.
- Per-app database isolation and tenant identity mapping.
- Project/database deletion semantics and recovery window.
- Backup/PITR availability for the selected plan.
- Connection TLS/pooling behavior and credential rotation path.
- Workspace-level managed database count, storage, compute, and spend guardrails.
- Orphan/recovery behavior when SSC state is restored behind existing provider database resources.
