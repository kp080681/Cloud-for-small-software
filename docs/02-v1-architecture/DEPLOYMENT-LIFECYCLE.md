# Node 02 - V1 Deployment Lifecycle

## Purpose

This document defines the canonical V1 path from a GitHub repository to a verified live application.

The deployment lifecycle is designed as an explicit state machine rather than a single synchronous request. Every important transition is persisted so the platform can recover after process crashes, provider timeouts, webhook duplication, or partial infrastructure provisioning.

The governing rule is:

> A deployment may fail, but its state must never become unknowable.

## High-level flow

```text
Connect GitHub
  -> Select repository
  -> Create application
  -> Analyse source
  -> Produce compatibility verdict
  -> Request missing configuration
  -> Freeze deployment plan
  -> Create deployment record
  -> Provision required resources
  -> Configure runtime
  -> Build
  -> Deploy
  -> Verify health
  -> Publish HTTPS URL
  -> Mark LIVE
```

## Core entities

### Application

Represents the long-lived software product being operated by the platform.

An application persists across many deployments.

Minimum conceptual fields:

- application_id
- workspace_id
- name
- source_repository_id
- production_branch
- runtime_profile
- database_mode
- current_live_deployment_id
- created_at
- deleted_at

### Source Revision

Identifies the exact code being deployed.

Minimum conceptual fields:

- repository_id
- branch
- commit_sha
- commit_message
- commit_timestamp

A deployment must always point to an immutable commit SHA.

### Analysis

Represents the platform's understanding of a particular source revision.

Minimum conceptual fields:

- analysis_id
- application_id
- commit_sha
- detected_framework
- detected_runtime
- detected_package_manager
- install_command
- build_command
- required_environment_variables
- database_requirement
- compatibility_status
- compatibility_reasons
- analyzer_version
- created_at

Analyses must be versioned because detection logic will evolve.

### Deployment Plan

A frozen plan generated after analysis and configuration validation.

The plan must describe exactly what will be attempted.

Minimum conceptual fields:

- deployment_plan_id
- application_id
- analysis_id
- source_commit_sha
- runtime_provider
- database_mode
- required_resource_intents
- secret_bindings
- build_configuration
- health_check_configuration
- plan_version

The deployment plan is immutable after execution begins.

### Deployment

Represents one attempt to make one source revision live.

Minimum conceptual fields:

- deployment_id
- application_id
- deployment_plan_id
- source_commit_sha
- status
- failure_category
- failure_message
- runtime_resource_id
- started_at
- completed_at
- created_by

A retry after a terminal failure should normally create a new deployment attempt rather than rewriting history.

## Canonical deployment states

```text
CREATED
ANALYSING
AWAITING_CONFIGURATION
READY
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
DELETING
DELETED
```

## Terminal states

Normal terminal states:

- LIVE
- FAILED
- CANCELLED
- DELETED

Terminal does not mean immutable operationally. A new deployment can be created from a LIVE or FAILED application state.

## Phase 1 - GitHub connection

### Trigger

User chooses Connect GitHub.

### Platform actions

1. Start GitHub App installation flow.
2. Store installation identifier and account identity.
3. Retrieve repositories the installation may access.
4. Never request broader repository access than required for the selected workflow.

### Persist before continuing

- github_installation record
- linked workspace
- provider account identity

### Failure behaviour

If authorization fails:

- no application is created
- user receives an explicit connection error
- partial OAuth/App-installation state is not interpreted as success

## Phase 2 - Repository selection

### Trigger

User selects a repository and production branch.

### Platform actions

1. Verify installation still has access.
2. Fetch repository metadata.
3. Resolve selected branch to current commit SHA.
4. Create application record.
5. Create source-revision record.
6. Queue analysis job.

### Important rule

The analysis job must use the resolved commit SHA rather than assuming the branch still points to the same source later.

### State transition

```text
CREATED -> ANALYSING
```

## Phase 3 - Source acquisition and analysis

### Analyzer inputs

The analyzer receives:

- repository identity
- immutable commit SHA
- supported configuration files
- project tree metadata
- package manifests and lockfiles
- framework configuration
- environment-variable examples where present

V1 should avoid cloning unnecessary repository history.

### Analyzer outputs

At minimum:

- framework
- Node.js/runtime requirement
- package manager
- install command
- build command
- environment variables
- PostgreSQL requirement
- unsupported features/dependencies
- compatibility verdict
- reasons/evidence

### Compatibility outcomes

#### SUPPORTED

The application matches a known V1 deployment profile.

Continue to configuration validation.

#### NEEDS_CONFIGURATION

The architecture is supported but required user-supplied values are missing.

Transition:

```text
ANALYSING -> AWAITING_CONFIGURATION
```

#### UNSUPPORTED

The application requires something outside the declared V1 boundary.

Transition:

```text
ANALYSING -> FAILED
```

Failure category:

```text
UNSUPPORTED_WORKLOAD
```

The UI should explain which requirement caused rejection.

## Phase 4 - Configuration collection

### Required configuration may include

- user-provided secrets
- existing DATABASE_URL
- managed PostgreSQL selection
- application-specific environment values
- health-check path when explicitly configured

### Rules

- secrets are never returned to the browser after initial submission except as masked metadata
- secrets are never written to GitHub
- missing required values block deployment
- optional values must not be treated as required merely because they are referenced in non-production code paths unless the analyzer has evidence

### Transition

When all required configuration is present:

```text
AWAITING_CONFIGURATION -> READY
```

or, when no configuration was missing:

```text
ANALYSING -> READY
```

## Phase 5 - Deployment-plan freeze

Before infrastructure work begins, create an immutable Deployment Plan.

The plan freezes:

- source commit
- analyzer result
- build command
- package manager
- runtime provider intent
- database intent
- secret bindings by secret ID/reference, not plaintext
- requested resources
- health verification rules

### Why freeze the plan

Without a frozen plan, configuration could change while a deployment is running, creating an unreproducible result.

New configuration changes apply to future deployments unless an operation is explicitly designed otherwise.

## Phase 6 - Queueing

User requests deployment or an allowed automation requests it.

Create deployment record first.

Then enqueue execution.

### Transition

```text
READY -> QUEUED
```

### Critical rule

The API request that starts deployment must not synchronously perform the full deployment.

The user-facing request should return once the deployment has been durably recorded and queued.

This protects control-plane latency and recovery.

## Phase 7 - Provisioning

### Transition

```text
QUEUED -> PROVISIONING
```

### Possible operations

- create managed PostgreSQL resource if requested
- create runtime project/resource
- allocate subdomain intent
- create provider-side environment target

### Idempotency

Every provisioning operation must have a platform-generated idempotency identity or reconciliation key.

Example conceptual key:

```text
workspace_id + application_id + resource_type + resource_generation
```

If a worker crashes after a provider creates a resource but before the control plane records success, retry logic must reconcile before creating another resource.

### Required persistence

After each provider resource is created, persist:

- platform resource ID
- provider
- provider resource ID
- resource type
- application ID
- ownership/lifecycle policy
- provisioning state

## Phase 8 - Runtime configuration

### Transition

```text
PROVISIONING -> CONFIGURING
```

### Operations

- bind managed database credentials if applicable
- inject user secrets
- inject platform-managed configuration
- configure build/runtime settings
- configure source revision or build artifact

### Secret handling rule

Workers should receive secrets only for the duration and scope necessary to configure the target resource.

Plaintext secrets must not be placed in logs, deployment events, analytics, or failure messages.

## Phase 9 - Build

### Transition

```text
CONFIGURING -> BUILDING
```

### Platform responsibilities

- trigger provider build
- persist provider deployment/build identifier
- ingest or link build logs
- poll or receive provider status events
- translate provider status into canonical deployment state

### Build failure

Transition:

```text
BUILDING -> FAILED
```

Possible failure categories:

- INSTALL_FAILED
- BUILD_COMMAND_FAILED
- MISSING_ENVIRONMENT_VARIABLE
- PACKAGE_MANAGER_ERROR
- PROVIDER_BUILD_ERROR
- BUILD_TIMEOUT

A failed build must not automatically be retried indefinitely.

Retries require either:

- a classified transient provider error, or
- explicit user action.

## Phase 10 - Deploy

### Transition

```text
BUILDING -> DEPLOYING
```

This state means the build artifact or runtime is being made addressable as an application.

Provider-specific deployment success is not yet platform success.

The platform must receive or retrieve:

- deployment/provider ID
- candidate URL
- provider completion status

## Phase 11 - Verification

### Transition

```text
DEPLOYING -> VERIFYING
```

The platform independently verifies the candidate application.

V1 checks should include where technically appropriate:

1. DNS/candidate URL resolves.
2. HTTPS handshake succeeds.
3. HTTP request receives an accepted response.
4. Redirects remain within an allowed pattern.
5. Application does not immediately return an obvious platform/runtime failure page.

### Accepted HTTP behaviour

A single hard-coded `200 only` rule is too naive.

Applications with authentication may legitimately respond with redirects or authentication status codes.

The health verifier must use a documented accepted policy based on the application profile.

### Verification failure

Transition:

```text
VERIFYING -> FAILED
```

Failure category:

```text
HEALTH_CHECK_FAILED
```

Provider deployment may remain available for debugging until cleanup policy determines otherwise.

## Phase 12 - Go live

After verification succeeds:

1. Mark deployment LIVE.
2. Set application.current_live_deployment_id.
3. Persist canonical live URL.
4. Emit deployment-live event.
5. Surface Open App action.

### Transition

```text
VERIFYING -> LIVE
```

The application may have previous LIVE deployments in history, but only one deployment is the current production pointer in V1.

## Deployment event log

Every significant transition should append a deployment event.

Conceptual event schema:

- event_id
- deployment_id
- event_type
- from_status
- to_status
- provider
- external_reference
- safe_metadata
- created_at

Examples:

```text
DEPLOYMENT_CREATED
ANALYSIS_STARTED
ANALYSIS_COMPLETED
CONFIGURATION_REQUIRED
DEPLOYMENT_QUEUED
DATABASE_PROVISIONING_STARTED
DATABASE_PROVISIONED
RUNTIME_CREATED
SECRETS_CONFIGURED
BUILD_STARTED
BUILD_FAILED
DEPLOY_STARTED
HEALTH_CHECK_STARTED
HEALTH_CHECK_FAILED
DEPLOYMENT_LIVE
DEPLOYMENT_CANCELLED
RESOURCE_DELETED
```

The event log must never contain secret plaintext.

## Worker crash recovery

Workers are disposable.

A worker must never be the only holder of deployment progress.

On startup or retry, a worker reads the persisted deployment state and reconciles it with provider state.

Example:

```text
Persisted state: PROVISIONING
Provider lookup: runtime already exists
Action: record/reconcile runtime ID and continue
```

Not:

```text
Persisted state: PROVISIONING
Worker assumes nothing happened
Action: create another runtime
```

## Provider timeout recovery

A timeout does not mean an operation failed.

For provider write operations:

1. send operation using idempotency/reconciliation identity where supported
2. if response times out, mark operation outcome UNKNOWN rather than failed
3. query provider using reconciliation metadata
4. determine CREATED / NOT_CREATED / STILL_PENDING
5. continue safely

The control plane must distinguish:

```text
FAILED
```

from:

```text
OUTCOME_UNKNOWN
```

at the internal operation level even if the user-facing deployment state remains in progress.

## Duplicate job delivery

Queue systems may deliver the same job more than once.

Therefore:

- jobs must be idempotent
- only valid state transitions may execute
- resource creation must reconcile before creation
- duplicate events must not cause duplicate side effects

Example:

If two workers receive the same deployment execution job, only one should be allowed to own the current transition lease, or both must produce equivalent safe behaviour through state locking/idempotency.

## State-transition validation

The control plane must reject illegal transitions.

Examples:

```text
CREATED -> LIVE          illegal
FAILED -> BUILDING       illegal for same attempt
LIVE -> BUILDING         illegal for same attempt
DELETED -> PROVISIONING  illegal
```

A new attempt is created instead of resurrecting a terminal deployment.

## Cancellation

V1 may support cancellation only at safe boundaries.

Possible transition:

```text
QUEUED / PROVISIONING / CONFIGURING / BUILDING -> CANCELLING -> CANCELLED
```

Cancellation is cooperative.

If the provider cannot cancel an operation immediately, the platform records cancellation intent and performs cleanup when the provider operation resolves.

## Redeployment

Redeployment means creating a new Deployment record.

Inputs may be:

- same commit, same configuration
- same commit, updated configuration
- newer commit

Deployment history remains intact.

The new deployment does not replace the current live deployment until verification succeeds.

This creates the future foundation for rollback.

## Failed deployment cleanup

Failure does not automatically mean every newly created resource should be deleted.

Resource policy must distinguish:

### Application-scoped persistent resources

Example:

- managed PostgreSQL database

These should generally survive an individual deployment failure.

### Deployment-scoped ephemeral resources

Example:

- failed build/deployment artifact

These may be cleaned automatically according to provider capability and retention policy.

This distinction must be encoded in resource ownership metadata.

## Deletion flow

Application deletion is a separate lifecycle from deployment failure.

Conceptual sequence:

```text
ACTIVE APPLICATION
  -> DELETING
  -> stop new deployments
  -> revoke platform access paths
  -> delete runtime resources
  -> optionally delete managed database after explicit confirmation/policy
  -> reconcile provider state
  -> remove/revoke managed credentials
  -> DELETED
```

Never mark DELETED while owned infrastructure remains unaccounted for unless explicitly recorded as a cleanup incident.

## User-visible progress

The UI should expose simple human-readable stages rather than provider internals.

Example:

```text
Analysing project
Waiting for configuration
Preparing infrastructure
Building application
Deploying
Checking application
Live
```

Advanced provider detail belongs in logs/debugging, not the primary flow.

## Latency principle

Deployment itself is an asynchronous infrastructure operation and may take meaningful time.

The control plane must remain responsive while deployment runs.

No dashboard request should wait for provider build completion.

Normal application traffic does not pass through the control plane after deployment.

## First V1 success definition

A deployment is successful only when all of the following are true:

- exact source revision recorded
- analysis completed
- configuration validated
- deployment plan frozen
- required resources reconciled/provisioned
- runtime configured
- build completed
- provider deployment completed
- HTTPS candidate available
- platform health verification passed
- canonical live URL persisted
- deployment marked LIVE
- event history complete enough to reconstruct the operation

## Non-negotiable invariant

At any moment, the platform must be able to answer four questions:

1. What application were we trying to deploy?
2. Which exact source revision and configuration were we deploying?
3. What step did we reach?
4. What infrastructure resources were created or modified?

If the system cannot answer all four after a crash, the architecture is not yet safe enough for external workloads.

## Next Node 02 decision

The next architecture document should define the V1 control-plane component model: which services/modules perform repository analysis, orchestration, queue execution, provider adaptation, secrets management, health verification, and event persistence.
