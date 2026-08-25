# Node 03 - Architecture Spike Plan

## Purpose

Node 03 exists to validate the riskiest V1 architecture assumptions with the minimum amount of code.

This is not the production product. It is an evidence-gathering exercise.

The governing principle is:

> Prove the deployment mechanism before building the platform around it.

## Primary question

Can Small Software Cloud take a known supported GitHub repository and, without manual provider-console configuration, turn an exact source revision into a healthy HTTPS application through our own orchestration path?

## Gold-path spike

```text
Known GitHub test repository
  -> resolve exact commit SHA
  -> create minimal application/deployment records
  -> create runtime resource programmatically
  -> inject required environment variables
  -> trigger build/deployment
  -> retrieve provider deployment state/logs
  -> obtain candidate HTTPS URL
  -> run independent health verification
  -> mark deployment LIVE
```

## Scope

### In scope

- one known Next.js test application
- one runtime provider adapter
- one PostgreSQL provider adapter if DB is included in second spike pass
- pinned GitHub commit
- minimal control-plane database schema
- minimal deployment state machine
- programmatic resource creation
- environment-variable injection
- build/deploy
- deployment-state polling/reconciliation
- health verification
- safe deletion/reconciliation
- measured deployment duration and infrastructure cost

### Explicitly out of scope

- polished UI
- public signup
- billing
- custom domains
- team sharing
- full analyzer
- full secrets UI
- public API
- CLI
- MCP
- agent integrations
- complex logs UI
- rollback UI
- multi-region
- external arbitrary code

## Spike sequence

### Spike A - Runtime-only deployment

Use the simplest possible supported Next.js repository with no database and no secrets beyond a harmless test environment variable.

Acceptance criteria:

1. repository and branch resolve to exact commit SHA
2. runtime resource created through API
3. test environment variable injected through API
4. build/deployment triggered through API
5. no manual provider dashboard setup required after credentials are configured
6. provider deployment status observable programmatically
7. candidate HTTPS URL retrieved programmatically
8. independent health check succeeds
9. deployment marked LIVE in our minimal state store
10. resource can be deleted safely through API
11. repeated delete is harmless or reconciled safely

### Spike B - Failure and retry behaviour

Deliberately introduce controlled failures.

Test at minimum:

- invalid build command or broken source revision
- provider timeout/network failure simulation where practical
- duplicate deployment execution request
- worker/task retry
- health-check failure
- delete after partially failed deployment

Acceptance criteria:

1. failed build never becomes LIVE
2. current state remains explainable
3. duplicate execution does not duplicate durable resources
4. uncertain provider write is reconciled before retry
5. retry behaviour is bounded
6. cleanup leaves no unexplained resource

### Spike C - Managed PostgreSQL

Use a minimal Next.js app that requires PostgreSQL.

Acceptance criteria:

1. database created programmatically through PostgresProvider adapter
2. resource ID and reconciliation key persisted
3. connection credential handled through secrets path
4. application receives only its own database credential
5. app deploys and successfully reads/writes a simple health/test record
6. database survives a failed redeploy because it is application-scoped
7. database deletion requires explicit application-resource deletion path
8. provider timeout/retry behaviour can be reconciled

### Spike D - Durable background execution

Run the same deployment through Trigger.dev managed task execution.

Acceptance criteria:

1. API/request thread does not wait for deployment completion
2. canonical state remains in PostgreSQL
3. task retry/restart can resume from persisted state
4. deployment truth is not trapped inside Trigger.dev state
5. concurrent duplicate task execution is prevented or made idempotent
6. per-deployment correlation IDs are preserved

### Spike E - KMS-backed secret handling

Validate the minimum secrets path using AWS KMS.

Acceptance criteria:

1. secret encrypted before persistence
2. master key remains outside control-plane database
3. encryption context includes intended tenant/secret context where supported
4. normal API cannot reveal plaintext after creation
5. deployment task decrypts only the required secret
6. plaintext does not appear in queue/task payloads
7. plaintext does not appear in logs/events
8. rotation/replacement path is technically viable

### Spike F - GitHub App integration

Replace any temporary source shortcut with the intended GitHub App path.

Acceptance criteria:

1. GitHub App install works
2. selected repository access works
3. repository contents are read-only
4. exact commit SHA is resolved and persisted
5. source inputs are read from the pinned revision
6. valid webhook signature is accepted
7. invalid webhook signature is rejected
8. duplicate delivery is safe
9. removing repository access prevents future source operations but does not affect live workload

## Spike implementation philosophy

Use the smallest codebase that can prove the contracts.

Do not build abstractions that are not required by the spike.

But do preserve these architectural boundaries from Node 02:

```text
source adapter
runtime adapter
postgres adapter
state transition validator
resource registry
provider operation tracking
health verifier
```

## Minimal data required

The spike may use a reduced schema derived from Node 02.

Minimum likely tables:

```text
applications
source_revisions
deployment_plans
deployments
deployment_events
resources
provider_operations
secrets / secret_bindings when secrets spike begins
```

Workspace/auth tables may be stubbed for the first internal spike if no user-facing multi-tenant surface exists yet.

Do not weaken tenant assumptions in production design merely because the first spike uses one internal workspace.

## Canonical deployment-attempt states for spike

```text
QUEUED
PROVISIONING
CONFIGURING
BUILDING
DEPLOYING
VERIFYING
LIVE
FAILED
CANCELLING
CANCELLED
```

No pre-deployment analysis states belong in the deployment-attempt state machine.

## Test repository

The first test repository should be intentionally boring.

Desired characteristics:

- Next.js
- current supported Node LTS
- pnpm or npm
- no database for Spike A
- one visible environment variable such as `APP_BUILD_MARKER`
- one simple route/page
- deterministic build
- no third-party API dependency

Do not use DealOS or Vantage as the first spike workload.

They are validation workloads after the mechanism works.

## Runtime adapter spike contract

Minimum methods to prove:

```text
createRuntime()
setEnvironment()
startDeployment()
getDeployment()
getBuildLogs()
getCandidateUrl()
deleteRuntime()
```

Reconciliation path must also be demonstrable.

## PostgreSQL adapter spike contract

Minimum methods to prove:

```text
createDatabase()
getDatabase()
getConnectionBinding()
deleteDatabase()
```

## Health verification spike

Initial verifier should:

- accept HTTPS only for provider URL
- use strict timeout
- cap redirects
- cap response size
- verify expected application marker/content or accepted status policy
- never allow arbitrary internal target URLs

## Instrumentation

Measure and record for every spike run:

```text
source resolution duration
runtime provisioning duration
build duration
deploy duration
health verification duration
total deploy-to-live duration
provider resource cost where observable
API/provider errors
retry count
resources created
resources deleted
```

The purpose is not optimization yet. It is to create a baseline.

## Manual provider-console rule

One-time platform credential/setup work is acceptable.

Examples:

- creating our Vercel account/team
- generating provider API credential
- creating GitHub App
- creating AWS KMS key

Per-application manual provider configuration is not acceptable for a successful spike.

A supported application must be provisioned by our code.

## Failure criteria

A spike is considered failed if any of the following remain unexplained:

- provider resource created but not traceable
- deployment status becomes unknowable after process/task restart
- duplicate execution creates duplicate persistent resources
- required application setup must be performed manually in provider console
- provider cannot expose enough state/logs to reconcile safely
- customer secret appears in logs/queue/event records
- control plane must proxy normal live application traffic
- runtime isolation model is incompatible with external-alpha security goals

Failure is useful evidence. The provider or architecture should then change before further build-out.

## Runtime security validation track

The spike must separately investigate Vercel's exact production isolation boundary.

Questions to resolve:

1. What isolation boundary applies to user projects at build time?
2. What isolation applies to long-lived/serverless runtime execution?
3. Can one workload access another project/team's environment or runtime resources?
4. What provider-enforced CPU/memory/execution limits exist?
5. What outbound-network controls/metadata protections exist?
6. What abuse controls and suspension primitives are available?
7. Does Vercel explicitly support arbitrary untrusted third-party production code under our intended architecture?

If the answer to 7 is not sufficiently clear, external-alpha runtime must remain blocked even if internal proof succeeds.

## Cost validation

Track separately:

```text
fixed platform cost
runtime cost per deployed app
database cost per app
build cost per deployment
idle app cost
lightly used app cost
```

The spike should test at least:

- one idle app
- one lightly exercised app
- one small managed PostgreSQL database

## Spike deliverables

At the end of Node 03, the repo should contain:

```text
SPIKE-PLAN.md
SPIKE-RESULTS.md
RUNTIME-ADAPTER-FINDINGS.md
POSTGRES-ADAPTER-FINDINGS.md
SECURITY-ISOLATION-FINDINGS.md
COST-BASELINE.md
```

Implementation code should remain in the same repository if this repo is confirmed as the product/code repository. If we later separate docs from product code, that must be an explicit repository decision.

## Node 03 exit gate

Node 03 passes only when all of the following are true:

1. a simple Next.js application goes from pinned GitHub revision to LIVE HTTPS URL through our code
2. no per-app manual provider configuration is required
3. deployment state survives task/process restart
4. provider writes are reconcilable
5. duplicate execution is safe
6. health verification independently gates LIVE
7. deletion leaves no unexplained resources
8. managed PostgreSQL can be provisioned and bound programmatically
9. KMS secret path works without plaintext leakage
10. GitHub App source path works with least privilege
11. actual early cost is measured
12. external-runtime isolation question has a documented answer or remains an explicit blocker

## Node 03 decision rule

If the spike proves the architecture, proceed to production control-plane foundation.

If it disproves a provider assumption, change the provider/adapter and repeat only the affected spike.

Do not build around a failed assumption.
