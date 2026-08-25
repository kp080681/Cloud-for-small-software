# Node 02 - V1 Reliability Model

## Purpose

This document defines how Small Software Cloud V1 should behave under normal operation, partial failure, provider degradation, crashes, retries, and recovery.

The objective is not to promise impossible perfection. The objective is to make failure predictable, visible, bounded, and recoverable while keeping customer applications independent of control-plane failures.

The governing principle is:

> Live customer applications should continue running even when the control plane is unhealthy.

## Reliability goals

V1 should optimise for five outcomes:

1. deployed applications remain available independently of the control plane
2. deployment state never becomes unknowable
3. retries never create duplicate or corrupted resources
4. failures are explainable and recoverable
5. control-plane interactions feel fast even when infrastructure work is slow

## Reliability domains

Small Software Cloud has three distinct reliability domains.

### 1. Customer runtime availability

The availability of deployed customer applications.

This depends primarily on the selected runtime/database providers and the customer's own application behaviour.

The control plane must not sit in the normal request path.

### 2. Control-plane availability

The availability of:

- dashboard
- API
- deployment status
- configuration management
- deployment requests
- logs and history

Control-plane downtime should not take live customer apps offline.

### 3. Deployment pipeline reliability

The ability to:

- analyse repositories
- queue work
- provision infrastructure
- build
- deploy
- verify
- recover from interruption

This pipeline is asynchronous and must survive worker/API restarts.

## Internal target direction

These are internal engineering targets, not initial public SLA commitments.

```text
Control-plane availability target: >= 99.9% as product matures
Supported deployment success rate: > 99% as compatibility stabilises
Configuration loss: 0 tolerated
Cross-tenant data exposure: 0 tolerated
Unsafe retry side effects: 0 tolerated
Ambiguous deployment state: 0 tolerated
Untracked external resources: effectively 0, with reconciliation
```

## Latency model

There are two latency categories.

### Control-plane latency

User-facing synchronous interactions should feel immediate.

Target direction for typical authenticated reads/writes:

```text
P50: < 200 ms where possible
P95: < 500 ms for ordinary control-plane requests
P99: < 1 s for ordinary control-plane requests
```

These are target budgets, not promises for every endpoint.

Requests involving bounded GitHub/provider metadata calls may exceed these occasionally, but long-running operations must never block the request lifecycle.

### Deployment latency

Deployment itself can take meaningful time.

The reliability requirement is not that deployment is instant.

It is that:

- progress is durable
- status is visible
- retries are safe
- the control plane stays responsive

## No runtime proxy rule

Normal application traffic should not pass through the control plane.

Preferred:

```text
End user -> Runtime provider -> Customer application
```

Avoid:

```text
End user -> Small Software Cloud -> Runtime provider -> Customer application
```

This reduces latency and prevents control-plane outages from becoming runtime outages.

## Failure domains

### API failure

If the control-plane API crashes:

- live customer apps remain online
- durable queued jobs remain queued
- worker may continue
- dashboard/API temporarily unavailable
- no new user actions accepted until recovery

### Worker failure

If a worker crashes:

- live customer apps remain online
- control-plane reads remain available
- active jobs are retried/resumed
- provider state is reconciled before further writes

### Queue failure

If the queue/workflow layer is unavailable:

- new long-running operations cannot start
- API should persist command intent/outbox state where possible
- live apps remain unaffected
- jobs dispatch when queue recovers

### Control-plane database failure

If the control-plane database is unavailable:

- no provider mutations should proceed blindly
- API/worker operations requiring canonical state should pause/fail safely
- live customer apps remain unaffected

### Runtime provider failure

If runtime provider is degraded:

- new deployments may pause/fail transiently
- existing apps may be affected according to provider availability
- control plane should show degraded provider status where known
- retry storms must be avoided

### PostgreSQL provider failure

If managed database provider is degraded:

- provisioning may pause
- existing customer databases may be affected according to provider behaviour
- platform should not repeatedly create replacement databases automatically

### GitHub failure

If GitHub is unavailable:

- live applications remain unaffected
- source analysis/new deployments pause
- existing deployment history remains available

## Durable command pattern

Every long-running user action should become a durable command.

Example:

```text
User clicks Deploy
  -> DB transaction creates deployment + outbox
  -> API returns
  -> dispatcher publishes job
  -> worker executes
```

The command is never represented only in memory.

## Transactional outbox

The outbox pattern is required for reliability between database commit and queue dispatch.

Problem avoided:

```text
deployment row committed
process crashes
queue message never sent
```

With outbox:

```text
same transaction:
- deployment row
- deployment event
- outbox event
```

A dispatcher retries until queue handoff succeeds.

## Idempotency

All infrastructure mutations must be safe against duplicate execution.

Required strategies:

- provider-native idempotency keys where available
- stable reconciliation keys
- database uniqueness constraints
- state transition validation
- resource lookup before retrying creation

## State-machine safety

Deployment transitions must be explicit and validated.

Illegal transitions are rejected.

Example:

```text
LIVE -> BUILDING
```

is illegal for the same deployment attempt.

A redeploy creates a new deployment record.

## Retry policy

Retry behaviour depends on classification.

### Retryable

Examples:

- transient network error
- provider 5xx
- provider rate limit
- temporary DNS propagation
- temporary health-check timeout

Use bounded exponential backoff with jitter.

### Non-retryable without changed input

Examples:

- compilation failure
- unsupported framework
- missing required secret
- invalid configuration
- authentication/permission problem requiring user action

Do not waste resources retrying automatically.

## Retry limits

Retries must be bounded.

A generic conceptual policy:

```text
attempt 1
retry after short delay
retry after increasing delay
stop after configured limit
mark failure or require reconciliation
```

Exact counts/time windows should be chosen per operation during implementation.

## Reconciliation

Reconciliation is a normal operating mechanism.

Used when:

- provider call times out
- webhook is missed
- worker crashes after provider write
- resource deletion remains pending
- control-plane/provider state diverges

Reconciliation asks:

```text
What does the provider actually have?
```

and then safely aligns control-plane state.

## Reconciliation cadence

V1 should support:

### Immediate reconciliation

For uncertain write outcomes.

### Retry-time reconciliation

Before repeating create/delete operations.

### Periodic reconciliation

For resources stuck in transitional states.

Examples:

```text
PROVISIONING too long
DELETING too long
OUTCOME_UNKNOWN
```

## Stuck-operation detection

Every transitional operation should have timestamps.

The platform should detect states that exceed expected duration.

Example categories:

```text
BUILD_STUCK
PROVISIONING_STUCK
DELETE_STUCK
HEALTH_CHECK_STUCK
```

A stuck operation triggers reconciliation or escalation, not silent indefinite waiting.

## Health verification reliability

Provider success is not enough.

The platform independently verifies candidate deployments.

Verification should use:

- strict timeout
- bounded redirects
- bounded response size
- limited retry window
- safe network destination rules

Do not let health verification become a general network access primitive.

## Health-check retry model

A newly deployed application may need a short warm-up period.

Conceptual policy:

```text
attempt health check
if transient failure:
  wait briefly
  retry bounded number of times
if persistent failure:
  mark HEALTH_CHECK_FAILED
```

Do not mark LIVE until verification passes.

## Current-live pointer safety

A new deployment must not replace the currently live deployment until the new one passes verification.

This protects production from failed redeployments.

Conceptually:

```text
old deployment = LIVE
new deployment = VERIFYING

if success:
  current_live_deployment_id -> new deployment

if failure:
  old deployment remains current
```

This is the foundation for future rollback.

## Failure containment

### Customer workload isolation

One customer's deployment failure must not block unrelated customers.

Use:

- per-deployment jobs
- concurrency limits
- provider-side isolation
- no shared mutable deployment state across tenants

### Provider blast radius

A provider outage should degrade only capabilities dependent on that provider.

Example:

Runtime provider down:
- new deployments blocked
- dashboard still available
- GitHub integration still available

## Concurrency limits

V1 should deliberately limit concurrent deployment/provisioning operations.

Reasons:

- prevent provider rate-limit storms
- control cost
- reduce blast radius
- simplify debugging

Concurrency can increase only after measurement.

## Backpressure

When workers are saturated:

- queue jobs
- expose queued status
- do not spawn unbounded execution

A calm queue is better than an overloaded control plane.

## Provider rate-limit handling

When rate-limited:

- respect `retry_after` / reset metadata
- reschedule job
- do not sleep worker for long periods
- avoid repeated identical calls

## Observability requirements

V1 reliability needs enough visibility to answer:

- how many deployments are running?
- how many are stuck?
- deployment success rate?
- provider error rate?
- queue depth?
- job retry count?
- reconciliation backlog?
- control-plane latency?
- control-plane error rate?

Minimum metrics should include:

```text
api_request_count
api_error_rate
api_latency
queue_depth
job_age
job_failure_rate
deployment_success_rate
deployment_duration
provider_error_rate
health_check_failure_rate
reconciliation_count
orphan_resource_count
```

## Logging requirements

Logs must be:

- structured
- timestamped
- correlated with request/deployment/job IDs
- secret-redacted
- useful for incident reconstruction

Recommended correlation identifiers:

```text
request_id
workspace_id
application_id
deployment_id
job_id
provider_operation_id
```

Avoid logging sensitive customer content unnecessarily.

## Alerting priorities

Earliest alerts should focus on high-impact conditions.

Examples:

- control-plane API unavailable
- database unavailable
- queue dispatch stalled
- worker backlog growing beyond threshold
- repeated provider authentication failures
- deployment success rate drops sharply
- reconciliation backlog grows
- orphan resources detected

Do not build a giant alerting system initially.

## Recovery objectives

V1 should define internal recovery objectives separately for control plane and customer apps.

### Control-plane RPO

Target direction:

```text
RPO near zero for committed control-plane state
```

This means durable database writes, backups, and no reliance on in-memory-only command state.

### Control-plane RTO

Target direction for early production:

```text
recover service within tens of minutes, then improve
```

Exact target depends on provider/tooling selected.

### Customer runtime RTO/RPO

Initially inherited mostly from runtime/database providers and the customer's application architecture.

Do not promise stronger guarantees than underlying providers actually deliver.

## Backup requirements

Before external alpha:

- control-plane database backups enabled
- backup restoration tested
- encryption keys stored separately
- backup retention understood
- restore procedure documented

A backup that has never been restored is not considered proven.

## Restore testing

At minimum, periodically test:

1. restore control-plane DB into isolated environment
2. verify critical tables/data integrity
3. verify encrypted secret records remain usable with correct key access
4. verify applications/deployments/resources remain traceable

## Deployment replay safety

After restore or crash recovery, the platform must not blindly replay all historic operations.

Only active/outstanding jobs should resume.

Provider operations must reconcile first.

## Provider outage behaviour

When provider status is clearly degraded:

- pause mutation-heavy retries
- preserve queued intent
- surface degraded state
- retry with bounded backoff
- avoid failing every job immediately unless failure is definitive

## Graceful degradation

Examples:

GitHub unavailable:
- dashboard works
- existing deployment history works
- new source operations unavailable

Runtime provider unavailable:
- source analysis can still work
- deployment execution pauses

Logs provider unavailable:
- deployment may still proceed if logs are non-critical
- UI marks log retrieval temporarily unavailable

## Maintenance windows

V1 should avoid requiring coordinated platform-wide downtime.

Database migrations should be designed for backward-compatible rolling application updates where practical.

For early alpha, short controlled maintenance may be acceptable, but the architecture should not depend on frequent downtime.

## Database migration reliability

Prefer:

```text
expand -> deploy compatible code -> migrate data -> contract
```

rather than destructive schema changes coupled to one deployment.

## Dependency timeouts

Every external dependency call requires explicit timeout.

No request should wait indefinitely on:

- GitHub
- runtime provider
- database provider
- DNS/health checks
- queue API

Timeouts should be tuned by operation type.

## Circuit-breaking behaviour

V1 does not require a sophisticated distributed circuit-breaker platform.

It does require basic shared awareness of repeated provider failure.

When failure thresholds are exceeded:

- mark provider DEGRADED/UNAVAILABLE internally
- reduce mutation attempts
- increase backoff
- surface status to operators

## Reliability test strategy

Before external alpha, test at least:

### Process crashes

- API crashes after deployment creation
- worker crashes during provisioning
- worker crashes after provider create succeeds but before DB update
- worker crashes during health verification

### Duplicate delivery

- duplicate queue job
- duplicate GitHub webhook
- duplicate provider webhook/event

### Provider failures

- timeout
- rate limit
- 5xx
- authentication failure
- slow response
- delete returns not found

### Database/queue failures

- queue unavailable after DB commit
- DB unavailable during worker execution
- outbox dispatcher restart

### Recovery

- stuck operation reconciliation
- restore control-plane database
- resume outstanding jobs safely

## Reliability quality gate

Before Gate 12 - External Alpha Ready, verify:

1. control-plane failure does not take live apps offline
2. long-running commands are durable
3. no deployment progress exists only in worker memory
4. provider timeouts reconcile safely
5. duplicate jobs do not duplicate resources
6. old live deployment remains active until new one verifies
7. stuck operations are detected
8. retries are bounded and classified
9. queue backpressure is controlled
10. control-plane DB restore is tested
11. key metrics and alerts exist
12. platform-added runtime latency is negligible by architecture

## Decision

Small Software Cloud V1 will prioritise failure containment, durable asynchronous execution, explicit state, idempotency, reconciliation, and independent runtime availability over complex active-active infrastructure.

The system should fail safely and visibly rather than attempt risky automatic recovery.

The next Node 02 document should define the Security Model: tenant isolation, authorization, credential boundaries, hostile repository input, workload execution risk, abuse controls, auditability, and the minimum security review required before external code is accepted.
