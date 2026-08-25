# Node 02 - Completion Review

## Purpose

This document closes Node 02 by reviewing the V1 architecture set for consistency, scope discipline, security, reliability, and readiness to enter Node 03 - Architecture Spike.

This review is authoritative when earlier Node 02 documents use conflicting wording.

## Documents reviewed

- SYSTEM-BOUNDARY.md
- DEPLOYMENT-LIFECYCLE.md
- CONTROL-PLANE-COMPONENTS.md
- DATA-MODEL.md
- PROVIDER-INTERFACES.md
- SECRETS-ARCHITECTURE.md
- GITHUB-INTEGRATION.md
- APPLICATION-ANALYZER.md
- RELIABILITY-MODEL.md
- SECURITY-MODEL.md
- TECHNOLOGY-DECISIONS.md

## Review outcome

Node 02 is accepted with two canonical clarifications documented below.

No material contradiction was found in:

- product scope
- control-plane ownership
- provider abstraction
- security posture
- tenant boundaries
- secrets handling
- repository trust model
- deployment recoverability
- bootstrap cost philosophy
- Next.js/Node/PostgreSQL V1 boundary

The architecture remains aligned with the whitepaper and master execution graph.

---

# Canonical clarification 1 - Analysis is pre-deployment

Some earlier lifecycle/data-model wording included:

```text
ANALYSING
AWAITING_CONFIGURATION
READY
```

inside the `Deployment` status list.

That wording is superseded.

## Canonical model

Repository analysis and configuration readiness belong to the **Application / Analysis / Deployment Plan** lifecycle.

A `Deployment` record is created only after:

1. source revision is pinned
2. analysis is complete
3. compatibility is acceptable
4. required configuration is present
5. deployment plan is frozen
6. user/automation requests deployment

Therefore the canonical V1 deployment-attempt states are:

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

Application deletion remains an application/resource lifecycle and should not be confused with deployment-attempt status.

## Pre-deployment status lives elsewhere

Analysis lifecycle:

```text
PENDING
RUNNING
COMPLETED
FAILED
```

Compatibility:

```text
SUPPORTED
NEEDS_CONFIGURATION
UNSUPPORTED
```

Application readiness can be derived from analysis + configuration rather than overloaded into deployment status.

## Why this is better

A deployment is now exactly what the name implies:

> one attempt to execute one frozen deployment plan.

This improves:

- auditability
- retry semantics
- state-machine simplicity
- data modelling
- implementation clarity

---

# Canonical clarification 2 - Background execution topology

CONTROL-PLANE-COMPONENTS.md originally described a separate background worker runtime as a deployable component.

TECHNOLOGY-DECISIONS.md later selected Trigger.dev Cloud as the initial managed execution layer.

These are not competing architectures.

## Canonical model

Logically, the system has a **Background Worker** boundary.

Physically in V1, that boundary is implemented using:

```text
Trigger.dev managed task execution
```

unless the architecture spike disproves the choice.

The code may live in the same repository and share packages/types with the control plane, while execution remains asynchronous and independently recoverable.

The requirement is not "we must operate a worker server."

The requirement is:

- long-running operations do not run inside synchronous API requests
- background execution is durable
- execution can retry/resume
- canonical state remains in our PostgreSQL control plane
- worker/task execution can be terminated without losing deployment truth

If Trigger.dev fails the spike, we can replace the physical implementation without changing the logical architecture.

---

# Scope review

## Still explicitly V1

```text
GitHub source
Next.js
Node.js
PostgreSQL
Environment variables
HTTPS URL
Deployment status
Basic build/runtime logs
Redeploy
Delete app
Basic resource limits
```

## Still explicitly outside V1

```text
Python
PHP
Java
.NET
Docker Compose
Kubernetes
GPU
Redis provisioning
arbitrary runtimes
complex microservices
our own physical compute
our own database engine
our own container scheduler
multi-region orchestration
full observability platform
public MCP/agent tooling before core deployment works
```

No Node 02 document overrides this boundary.

---

# Architecture invariants accepted

## Control plane

- our PostgreSQL database is canonical for ownership, intent, and lifecycle
- provider state is reconciled, not blindly trusted as product state
- customer runtime traffic does not normally pass through our control plane

## Deployment

- every deployment pins an immutable source revision
- a deployment plan is frozen before execution
- provider success is not enough; health verification is required
- a failed replacement deployment does not displace the current live deployment
- retries create new attempts when the previous attempt is terminal

## Reliability

- long-running work is durable/asynchronous
- queue/workflow delivery may be duplicated
- provider calls may time out after succeeding
- idempotency + reconciliation are required
- live customer apps must survive control-plane/worker outages where provider infrastructure remains healthy

## Security

- customer code is untrusted
- analyzer performs static inspection only
- customer code never executes in the control-plane process
- customer workloads never receive control-plane/provider-admin credentials
- secrets are encrypted and narrowly decrypted
- tenant ownership is checked for every sensitive object/action
- arbitrary external code is blocked until isolation review passes

## Providers

- vendor-specific behavior stays behind adapters
- one runtime and one managed PostgreSQL provider are sufficient for V1
- multi-cloud is not a V1 requirement

---

# Technology choices accepted for spike

Proceed with the following as **spike candidates**, not irreversible commitments:

```text
TypeScript
Next.js
Vercel - control plane
Neon - control-plane PostgreSQL
Trigger.dev - background orchestration
Clerk - authentication
AWS KMS - secret root-key boundary
GitHub App - source integration
Vercel - customer runtime candidate
Neon - managed customer PostgreSQL candidate
Cloudflare - platform DNS
Sentry - control-plane error monitoring
pnpm
Drizzle - ORM candidate
```

The architecture spike may reject or modify a provider without invalidating Node 02 if the provider interfaces and architectural invariants remain intact.

---

# Open questions deliberately moved to Node 03

These are not missing architecture decisions. They require empirical validation.

1. Can Vercel projects be created/configured/deployed/deleted entirely through APIs without manual dashboard intervention?
2. Can a pinned GitHub revision be deployed reproducibly through our orchestration path?
3. What precise Vercel build/runtime isolation guarantees apply to arbitrary external untrusted code?
4. Can Neon project/database provisioning and deletion be reconciled safely after timeouts?
5. What are real cold-start and low-usage costs for Neon customer databases?
6. Can Trigger.dev tasks preserve our PostgreSQL state machine as canonical and support required concurrency/retry semantics?
7. Can AWS KMS encryption-context/least-privilege policies implement the designed secret boundary cleanly?
8. Can Clerk remain strictly an identity provider while our database owns workspace authorization?
9. What is the true cost of one idle and one lightly used application?
10. Can we execute the first gold-path deployment without touching provider dashboards manually?

---

# Node 03 entry criteria

Node 03 may begin because:

- product boundary is frozen
- system ownership boundary is frozen
- deployment lifecycle is defined
- data model is defined
- provider interfaces are defined
- secrets architecture is defined
- GitHub trust/permission model is defined
- analyzer rules are defined
- reliability model is defined
- security model is defined
- technology candidates are selected
- contradictions identified in review have canonical resolutions

---

# Node 03 goal

The Architecture Spike should prove the smallest possible end-to-end technical chain:

```text
Known GitHub test repository
        ->
Pinned commit
        ->
Minimal control-plane record
        ->
Programmatic runtime provisioning
        ->
Environment configuration
        ->
Build/deploy
        ->
Candidate HTTPS URL
        ->
Independent health check
        ->
LIVE
```

The spike is not the production product.

It exists to invalidate assumptions cheaply before we build the full control plane.

---

# Node 03 non-goals

Do not build yet:

- polished dashboard
- billing
- custom domains
- team management beyond what spike requires
- complete analyzer
- complete secret UI
- public signup
- public external deployment
- CLI
- MCP
- agent integration
- sophisticated logs UI

Node 03 should answer architecture questions with the minimum code necessary.

---

# Node 02 decision

**Node 02 - V1 Architecture is COMPLETE.**

The architecture is sufficiently coherent to proceed to Node 03 - Architecture Spike.

Node 03 should begin with a written spike plan and acceptance criteria before production-style implementation starts.
