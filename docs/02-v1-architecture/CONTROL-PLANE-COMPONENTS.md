# Node 02 - V1 Control Plane Components

## Purpose

This document defines the minimum software components required for the Small Software Cloud V1 control plane.

The design goal is to meet the reliability, security, and recoverability requirements already established without introducing unnecessary distributed-system complexity.

The governing principle is:

> Start as a modular monolith with durable asynchronous workers, not a collection of microservices.

## Architecture decision

V1 should consist of four deployable building blocks:

1. Control Plane Web/API Application
2. Background Worker Runtime
3. Control Plane PostgreSQL Database
4. External Infrastructure Providers accessed through adapters

A durable queue or workflow mechanism sits between the API application and background execution.

Conceptually:

```text
Browser / CLI / Future Agent
          |
          v
CONTROL PLANE WEB + API
          |
          +----> CONTROL PLANE DATABASE
          |
          +----> DURABLE JOB / WORKFLOW QUEUE
                         |
                         v
                  BACKGROUND WORKER
                         |
        +----------------+----------------+
        |                |                |
        v                v                v
   GitHub Adapter   Runtime Adapter   Database Adapter
                                          |
                                     Other Providers
```

The control plane is logically modular but does not require independently deployed services for each module in V1.

## Why not microservices

Microservices would add:

- network failure modes between internal components
- distributed tracing requirements
- service discovery
- duplicated authentication/authorization concerns
- deployment coordination
- more infrastructure cost
- more operational surfaces
- more complex local development

None of these improve the core V1 user promise.

The platform should split components into separate services only when there is a measured reason such as:

- independent scaling requirements
- security isolation requirements
- different runtime requirements
- operational blast-radius reduction
- materially different availability requirements

Until then, logical modules inside one codebase are sufficient.

## Component 1 - Control Plane Web/API Application

### Responsibility

This is the synchronous product surface.

It owns:

- authentication/session handling
- workspaces
- GitHub connection UI and callbacks
- repository selection
- application creation
- configuration management
- deployment requests
- status reads
- log/event reads
- redeploy/delete requests
- future CLI/API/agent-facing endpoints

### Critical rule

The API application does not perform long-running infrastructure work inline.

It may validate intent, create durable records, and enqueue work.

It should then return promptly.

### Example

User clicks Deploy.

The API application should:

1. authorize user against workspace/application
2. verify application is deployable
3. create immutable deployment plan if not already frozen
4. create deployment record
5. append deployment-created event
6. enqueue deployment execution
7. return deployment ID/status URL

It should not:

- wait for database provisioning
- wait for provider builds
- poll deployment completion inline
- run health checks synchronously inside the request

## Component 2 - Durable Job / Workflow Layer

### Responsibility

This is the bridge between user intent and infrastructure execution.

It provides:

- durable job creation
- retries
- delayed retry/backoff
- duplicate-delivery tolerance
- job visibility
- worker recovery

### V1 design rule

The queue must be durable enough that restarting the control-plane API or worker does not lose a deployment request.

### Job types

Likely V1 jobs include:

```text
ANALYSE_REPOSITORY
EXECUTE_DEPLOYMENT
RECONCILE_DEPLOYMENT
VERIFY_DEPLOYMENT
DELETE_APPLICATION_RESOURCES
PROCESS_GITHUB_WEBHOOK
RECONCILE_ORPHAN_RESOURCES
```

These may initially be implemented using one queue/workflow technology rather than separate systems.

### Job payload rule

Queue payloads should contain identifiers, not large mutable state.

Prefer:

```text
{ deployment_id }
```

rather than embedding:

```text
source files
plaintext secrets
full deployment plan
provider credentials
```

The worker rehydrates canonical state from the control-plane database.

## Component 3 - Background Worker

### Responsibility

The worker performs long-running and failure-prone operations.

It owns execution of:

- repository analysis
- infrastructure provisioning
- secret injection into provider resources
- build/deploy triggers
- provider polling/reconciliation
- health verification
- resource deletion
- cleanup/reconciliation tasks

### Worker design principle

Workers are disposable.

A worker must be safe to terminate at any point.

The next worker should be able to resume by reading persisted state and reconciling with providers.

### Concurrency control

Only one active worker should normally advance a single deployment transition at a time.

Possible V1 mechanisms include:

- database row locking
- advisory locks
- queue-level uniqueness
- lease records with expiry

The exact mechanism is a later implementation choice, but the invariant is required now.

### Retry policy

Retries must depend on failure classification.

Examples:

Transient:
- provider timeout
- rate limit
- temporary network error
- provider 5xx

May retry with bounded exponential backoff.

Non-transient:
- invalid build command
- unsupported framework
- missing required secret
- compilation error

Do not retry automatically without changed input or explicit action.

## Component 4 - Control Plane PostgreSQL Database

### Responsibility

This is the canonical system of record.

It stores control-plane state such as:

- users/workspaces
- GitHub installations
- repositories
- applications
- analyses
- configuration metadata
- encrypted secret material or secure references
- deployment plans
- deployments
- deployment events
- provider resources
- domains
- audit records
- usage records later

### Critical rule

Provider state is not authoritative over product state.

Providers supply external facts, but the control-plane database remains the canonical record of ownership, intent, and lifecycle.

### Transaction boundary

Local state changes that must occur together should use database transactions.

Example:

When creating a deployment request, the system should atomically create:

- deployment record
- initial deployment event
- outbox/job intent where the chosen queue pattern permits

This reduces states such as:

```text
Deployment exists but was never queued
```

or:

```text
Queue job exists but deployment record does not
```

## Component 5 - GitHub Adapter Module

This is a logical module inside the control plane/worker codebase in V1.

### Responsibility

- GitHub App installation interaction
- repository listing
- repository metadata reads
- branch -> commit resolution
- source/configuration file retrieval
- webhook signature verification
- webhook normalization

### Boundary

The rest of the platform should consume normalized interfaces instead of GitHub-specific response structures.

Conceptual methods:

```text
listRepositories(installation)
resolveRevision(repository, branch)
readFile(repository, commitSha, path)
listProjectTree(repository, commitSha)
verifyWebhook(headers, body)
```

## Component 6 - Application Analyzer Module

### Responsibility

Turns repository evidence into a deterministic application analysis.

Inputs:

- repository tree
- package manifest
- lockfile
- framework config
- selected safe source/config files
- analyzer rules/version

Outputs:

- framework
- runtime
- package manager
- build/install commands
- environment variable requirements
- database requirement
- compatibility verdict
- evidence/reasons

### Architecture rule

Analyzer output is persisted.

It is not recalculated unpredictably every time the UI loads.

### AI rule

Critical V1 compatibility decisions should remain deterministic where possible.

AI may later assist with uncertain cases but should not silently override hard compatibility rules.

## Component 7 - Deployment Orchestrator Module

### Responsibility

This is the core workflow brain.

It reads persisted deployment state and decides the next valid operation.

Conceptual responsibilities:

```text
advanceDeployment(deploymentId)
reconcileDeployment(deploymentId)
failDeployment(deploymentId, category, safeMessage)
markDeploymentLive(deploymentId)
```

The orchestrator does not contain provider-specific API logic directly.

It calls provider adapters.

## Component 8 - Runtime Provider Adapter

### Responsibility

Abstract runtime-provider operations.

Conceptual interface:

```text
createApplicationRuntime(intent)
configureEnvironment(runtimeId, secretBindings, config)
triggerBuild(runtimeId, revision)
getDeploymentStatus(providerDeploymentId)
getBuildLogs(providerDeploymentId)
getRuntimeLogs(runtimeId)
getCandidateUrl(providerDeploymentId)
deleteRuntime(runtimeId)
```

### Rule

Provider identifiers are persisted in resource records, never inferred from names alone.

## Component 9 - Database Provider Adapter

### Responsibility

Support both V1 database modes.

#### Existing database

The platform stores/binds a user-provided connection secret.

No database is provisioned.

#### Managed PostgreSQL

The platform requests a database from the selected provider and records the resulting resource.

Conceptual interface:

```text
createPostgres(intent)
getPostgresStatus(resourceId)
getConnectionBinding(resourceId)
deletePostgres(resourceId)
```

Provider-specific credentials must not leak into generic logs/events.

## Component 10 - Secrets Module

### Responsibility

- encrypt user-provided secrets
- store secret metadata
- retrieve/decrypt only when authorized execution requires it
- bind secrets to application/environment
- prevent plaintext logging
- support later rotation

### V1 principle

Secrets are control-plane data with stronger handling requirements than ordinary configuration.

The codebase should make it difficult to accidentally serialize plaintext secrets into:

- logs
- events
- analytics
- queue payloads
- API responses

## Component 11 - Health Verification Module

### Responsibility

Independently verify candidate deployments before LIVE.

V1 checks may include:

- DNS resolution/candidate URL reachability
- TLS handshake
- HTTP response
- accepted redirect behaviour
- obvious provider/runtime error detection

### Isolation principle

Health verification runs outside the customer application process.

The verifier should use strict timeouts and response-size limits.

It must not become a general-purpose internal-network scanner.

## Component 12 - Event and Audit Module

### Deployment events

Operational events tied to deployments.

Examples:

```text
ANALYSIS_COMPLETED
BUILD_STARTED
BUILD_FAILED
DEPLOYMENT_LIVE
```

### Audit events

Security/product actions tied to actors.

Examples:

```text
GITHUB_CONNECTED
SECRET_CREATED
SECRET_UPDATED
APPLICATION_DELETED
MEMBER_INVITED
```

The two concepts may initially share infrastructure but should remain semantically distinct.

## Component 13 - Resource Registry

### Responsibility

Track every external resource the platform creates or manages.

Minimum information:

- resource_id
- workspace_id
- application_id
- deployment_id where relevant
- provider
- provider_resource_id
- resource_type
- lifecycle_scope
- status
- created_at
- deleted_at

### Lifecycle scopes

At minimum:

```text
APPLICATION
DEPLOYMENT
```

Examples:

PostgreSQL database -> APPLICATION
Deployment artifact -> DEPLOYMENT
Runtime project -> likely APPLICATION
Provider deployment -> DEPLOYMENT

This registry is essential for cleanup and reconciliation.

## Component 14 - Reconciliation Module

### Responsibility

Detect mismatch between control-plane state and provider reality.

Examples:

- control plane thinks resource provisioning timed out, but provider created it
- control plane marks resource deleting, provider still reports it active
- webhook was missed
- worker crashed after provider action

Reconciliation may run:

- immediately after uncertain outcomes
- on retries
- periodically for active/transitioning resources

### V1 principle

Reconciliation is part of normal architecture, not an emergency script.

## Recommended V1 deployment topology

```text
                 Internet
                    |
                    v
          Control Plane Web/API
                    |
          +---------+----------+
          |                    |
          v                    v
      PostgreSQL          Durable Queue
                               |
                               v
                         Worker Runtime
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
           GitHub          Runtime Provider   DB Provider
```

The Web/API and Worker may come from the same repository/codebase but run as separate processes/deployments.

This gives us:

- independent worker restarts
- long-running background execution
- simple code sharing
- low infrastructure complexity
- room to split later only if required

## Suggested codebase module boundaries

Conceptual structure:

```text
src/
  auth/
  workspaces/
  github/
  applications/
  analyzer/
  configuration/
  secrets/
  deployments/
  orchestration/
  providers/
    runtime/
    postgres/
  health/
  events/
  audit/
  resources/
  reconciliation/
  jobs/
```

This is a logical architecture, not a requirement to use these exact directory names.

The critical point is that provider-specific code stays behind adapters and orchestration logic stays independent of HTTP/UI code.

## Dependency rules

### UI/API may depend on

- application services
- authorization
- deployment command services
- read models

### UI/API should not depend directly on

- provider SDKs for long-running operations
- plaintext secret storage implementation
- raw queue internals

### Orchestrator may depend on

- repositories/data access
- provider interfaces
- event writer
- resource registry
- state transition validator

### Provider adapters must not own

- product authorization rules
- deployment state machine
- customer-facing business logic

## Control-plane latency requirements

Synchronous user operations should normally perform only:

- authorization
- database reads/writes
- bounded GitHub/provider metadata calls where required
- enqueueing

Long operations must move to workers.

This supports the project goal of a calm, responsive control plane even while infrastructure tasks take longer underneath.

## Blast-radius strategy

V1 does not need microservices to achieve useful isolation.

We can reduce blast radius through:

- separate API and worker processes
- least-privilege credentials
- separate provider credentials by purpose where feasible
- strict module boundaries
- database transaction boundaries
- rate limits
- worker concurrency limits
- provider-side workload isolation

## Security boundaries

### Control Plane Web/API

May access:
- control-plane database
- GitHub metadata operations
- queue submission

Should not require broad runtime-provider mutation credentials if those can remain worker-only.

### Worker

May require:
- provider mutation credentials
- temporary secret decryption access

Therefore the worker is a higher-sensitivity component and should have tighter access controls and no public inbound interface except infrastructure-required mechanisms.

### Customer runtime

Must never have:
- control-plane database credentials
- platform provider credentials
- other tenants' secrets
- queue credentials

Only application-specific secrets/configuration are provided.

## Failure containment

If the API application crashes:

- live customer apps remain unaffected
- queued deployments remain durable
- worker may continue depending on queue/runtime

If the worker crashes:

- live customer apps remain unaffected
- API/dashboard remains available
- jobs retry/resume

If the control-plane database is unavailable:

- no unsafe provider mutations should proceed blindly
- live customer apps should continue serving because the control plane is not in their request path

This separation is one of the central V1 reliability benefits.

## Explicitly not separate V1 services

Do not independently deploy these unless evidence requires it:

- Analyzer Service
- Secrets Service
- GitHub Service
- Deployment Service
- Audit Service
- Health Service
- Billing Service
- Domain Service

They are modules first.

## Architecture promotion rule

A module may become an independent service only when at least one of these is demonstrated:

1. it needs materially independent scaling
2. it requires a different security boundary
3. it requires a different runtime/technology
4. failure isolation materially improves reliability
5. development velocity is being measurably harmed by remaining together

Architecture fashion is not a reason.

## V1 component summary

```text
Deployable components

1. Control Plane Web/API
2. Background Worker
3. PostgreSQL Control Plane DB
4. Durable Queue/Workflow Layer

Logical modules

- Auth/Workspaces
- GitHub
- Applications
- Analyzer
- Configuration
- Secrets
- Deployment Orchestrator
- Runtime Adapter
- Database Adapter
- Health Verification
- Events/Audit
- Resource Registry
- Reconciliation
```

## Decision

Small Software Cloud V1 will use a modular-monolith control plane with separate synchronous API and asynchronous worker execution.

We will deliberately avoid internal microservices until scale, isolation, or reliability evidence requires them.

The next Node 02 document should define the canonical control-plane data model and relationships between workspaces, applications, analyses, deployments, resources, secrets, and events.
