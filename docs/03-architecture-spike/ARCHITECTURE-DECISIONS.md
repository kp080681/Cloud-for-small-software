# Node 03 — Architecture Spike Consolidation

**Status:** COMPLETE  
**Date:** 2026-08-26

## Purpose

Node 03 existed to answer the highest-risk infrastructure questions before Small Software Cloud became a product build. The rule was simple: prove important assumptions against real provider APIs instead of designing an elaborate paper cloud.

All six planned architecture spikes passed.

```text
Spike A  Runtime provisioning        PASS
Spike B  Reconciliation/failures     PASS
Spike C  PostgreSQL provisioning     PASS
Spike D  Durable execution           PASS
Spike E  KMS secret management       PASS
Spike F  GitHub App integration      PASS
```

The project can now move from isolated infrastructure experiments to an integrated V1 control plane.

---

## V1 architecture decision

Small Software Cloud will begin as an orchestration/control-plane product built on mature infrastructure providers.

It will not build its own compute fabric, database engine, key-management system, DNS network, TLS stack, or job runtime in V1.

The control plane owns product state and orchestration. Provider resources are external effects that must be reconciled against that state.

### Initial boundaries

```text
Builder / future agent
        |
        v
Small Software Cloud Control Plane
        |
        +--> GitHub App
        |      source + exact commit identity
        |
        +--> PostgreSQL
        |      canonical product/deployment state
        |
        +--> KMS-backed secret store
        |      encrypted application secrets
        |
        +--> Durable worker/orchestrator
        |      deployment workflow + retries
        |
        +--> Runtime provider
        |      build/runtime/HTTPS
        |
        +--> PostgreSQL provider
               application database when required
```

Control-plane infrastructure and customer workloads remain conceptually separate even when early managed providers simplify physical infrastructure.

---

## Decision 1 — GitHub source identity

**Use a GitHub App with installation-scoped access.**

Do not make user-supplied personal access tokens the normal V1 integration model.

V1 repository flow:

```text
Install GitHub App
→ select permitted repositories
→ persist installation mapping
→ list only accessible repositories
→ select repository
→ resolve default/configured branch
→ resolve exact commit SHA
→ inspect project
```

Minimum proven permission for source inspection: `Contents: Read-only`.

The exact commit SHA, not merely a mutable branch name, becomes part of deployment identity.

---

## Decision 2 — PostgreSQL is canonical state

**The control-plane PostgreSQL database is the source of truth for deployment intent and lifecycle state.**

Trigger.dev, runtime providers, database providers and other external systems are execution/providers, not the canonical product database.

Provider IDs and URLs are persisted as mappings/effects of canonical state.

A browser or CLI request must not need to remain connected for a deployment to finish.

---

## Decision 3 — Durable deployment orchestration

**Use durable asynchronous execution for deployment workflows.**

A deployment request should:

1. validate authorization and requested app/revision,
2. create/update canonical deployment state,
3. enqueue durable work,
4. return quickly to the caller,
5. continue independently in the worker,
6. persist every meaningful transition,
7. retry only retry-safe operations,
8. reconcile uncertain provider outcomes,
9. finish in a terminal state or actionable failure state.

The deployment worker must be restart-safe and idempotent at provider boundaries.

---

## Decision 4 — Reconciliation over optimistic API calls

**External provider calls are not truth by themselves.**

Every resource operation must account for:

- request timeout after provider success,
- duplicate worker execution,
- provider-side partial completion,
- stale local state,
- retries after process failure,
- resource deletion outside the platform.

Where possible, provider resources should carry deterministic external identifiers/tags so the control plane can discover whether an operation already succeeded.

Desired state + observed provider state determines the next action.

---

## Decision 5 — Application PostgreSQL provisioning

**Provision PostgreSQL through a managed provider behind an internal provider interface.**

The product model should not expose provider-specific concepts unless required.

Initial logical contract:

```text
provisionDatabase(app)
getDatabase(app)
deleteDatabase(app)
```

Provider project/database identifiers remain internal mappings.

The resulting application connection string is treated as a secret and enters the same secret-handling path as user-supplied environment variables.

This interface allows the underlying PostgreSQL provider to change later without redesigning the product model.

---

## Decision 6 — Secret storage

**Use envelope encryption backed by an external KMS root of trust.**

Persistent control-plane storage contains encrypted material, not application secret plaintext.

Proven model:

```text
KMS GenerateDataKey
→ plaintext data key exists transiently in trusted process memory
→ AES-256-GCM encrypt secret
→ persist ciphertext + encrypted data key + crypto metadata
→ worker loads encrypted record when required
→ KMS Decrypt data key
→ decrypt secret transiently in trusted worker memory
```

Cryptographic context binds secrets to application/workspace scope.

Never print application plaintext secrets, KMS plaintext data keys, GitHub installation tokens, GitHub App JWTs, or provider credentials in logs.

Long-lived IAM access keys used during the spike are acceptable proof tooling, not the preferred final production identity model. Prefer short-lived/workload identity where supported before public arbitrary workloads.

---

## Decision 7 — Runtime provider abstraction

**Use a managed runtime provider first and isolate provider-specific logic behind a small adapter.**

Initial logical contract:

```text
createDeployment(app, revision, configuration)
getDeployment(deployment)
deleteAppRuntime(app)
```

V1 should optimize for the supported stack only:

- GitHub source
- Next.js
- Node.js
- PostgreSQL

Do not generalize into a universal runtime abstraction prematurely.

---

## Canonical V1 deployment lifecycle

The first integrated implementation should converge on these states rather than inventing a large workflow taxonomy:

```text
DRAFT
READY
QUEUED
ANALYZING
PROVISIONING
BUILDING
DEPLOYING
HEALTH_CHECKING
LIVE
FAILED
DELETING
DELETED
```

A deployment record should at minimum retain:

- workspace ID
- app ID
- deployment ID/key
- GitHub installation/repository identity
- exact source commit SHA
- detected framework/runtime
- requested configuration
- current status
- attempt/retry information
- provider resource IDs
- deployment URL when available
- safe structured error information
- timestamps

Status names may be refined during Node 04, but PostgreSQL remains canonical.

---

## Failure model

Failures should be translated into actionable platform concepts.

Initial categories:

```text
SOURCE_ACCESS_FAILED
PROJECT_UNSUPPORTED
CONFIGURATION_REQUIRED
DATABASE_PROVISION_FAILED
BUILD_FAILED
RUNTIME_PROVISION_FAILED
HEALTH_CHECK_FAILED
PROVIDER_UNAVAILABLE
INTERNAL_ORCHESTRATION_FAILED
```

Do not surface raw provider errors as the primary customer experience. Preserve safe provider diagnostics internally while presenting an understandable action externally.

---

## Security invariants for Node 04

These are architectural requirements, not later polish:

1. Every control-plane object is workspace scoped.
2. GitHub installation/repository access must be authorized to that workspace.
3. Customer secrets are encrypted at rest and never intentionally logged.
4. Provider credentials are never exposed to customer workloads.
5. Workers receive only the credentials/scope required for the current operation.
6. Provider resources have deterministic ownership metadata where supported.
7. Deployment operations are idempotent/reconcilable.
8. Deletion is explicit, auditable and safe to retry.
9. Customer workload execution is not considered safe for public arbitrary code until isolation is reviewed.
10. Resource limits are part of the public-workload safety boundary.

---

## What Node 03 proved

The project now has real evidence for the major infrastructure chain:

```text
GitHub App
→ scoped private source access
→ exact source revision
→ canonical PostgreSQL state
→ encrypted secret persistence
→ durable asynchronous execution
→ managed database provisioning
→ managed runtime provisioning
→ reconciliation/failure handling
```

This substantially reduces the architectural uncertainty around the V1 thesis.

---

## What remains deliberately unproven

Node 03 does not claim production readiness.

Important work still remains around:

- customer authentication and workspace authorization
- complete control-plane schema and API
- integrated GitHub installation callback flow
- project/framework detection
- end-to-end secret injection into builds/runtime
- end-to-end database attachment
- runtime health checks
- stable platform subdomains/DNS/TLS integration
- workload isolation review
- build isolation
- egress/network controls
- CPU/memory/storage limits
- abuse prevention and rate limits
- audit logs
- backup/restore policy
- provider credential rotation
- GitHub webhooks and installation lifecycle
- observability and safe logs
- deletion across all providers
- cost/margin measurement per workload

These are implementation/security tasks for the integrated product, not reasons to continue creating disconnected spikes indefinitely.

---

# Node 04 entry criteria

Node 03 is complete. Node 04 may begin.

## Node 04 objective

Build the smallest integrated control-plane path that can eventually satisfy the V1 benchmark:

```text
Connect GitHub
→ select repo
→ analyse project
→ detect requirements
→ add required secrets
→ provision PostgreSQL if required
→ deploy
→ health check
→ return HTTPS URL
```

## Node 04 first vertical slice

Do not build the whole dashboard first.

The first slice should be executable through a minimal internal API/CLI and should target one controlled test application.

Build in this order:

```text
1. Control-plane schema + state machine
2. GitHub installation/repository mapping
3. Repository inspection + Next.js detection
4. App/deployment creation API
5. Durable deployment job
6. KMS secret retrieval/injection
7. Database provisioning hook
8. Runtime deployment hook
9. Status reconciliation
10. Health check + live URL
```

Only after this path works should substantial product UI be layered on top.

## First workload

Use an ordinary DealUp application/site as the first integrated workload. It must not contain platform-specific deployment hacks.

After that succeeds:

```text
DealUp workload
→ DealOS
→ Vantage
→ additional test apps
→ external alpha
```

---

## Scope guard

Before adding anything during Node 04 ask:

> Does this directly help us deploy, operate, secure or monetize small software?

If not, defer it.

Do not add custom domains, rollback UI, backups UI, billing, team sharing, authentication gateway, extra frameworks/runtimes or elaborate dashboard design before the core integrated deployment path works.

**Revenue earns complexity.**
