# Node 02 - V1 Provider Interfaces

## Purpose

This document defines the provider abstraction layer for Small Software Cloud V1.

The goal is not to make every infrastructure provider interchangeable on day one. The goal is to prevent provider-specific API shapes, lifecycle assumptions, and error semantics from leaking into core orchestration logic.

The governing principle is:

> Providers are implementations. The control plane owns the contract.

## Why this matters

If core deployment logic directly depends on one provider SDK everywhere, then the provider becomes part of the product architecture.

That creates problems later:

- migration becomes expensive
- multi-provider support becomes invasive
- provider outages are harder to isolate
- provider-specific errors leak into the product
- economics become harder to optimise
- internal business logic becomes difficult to test

V1 therefore uses narrow provider interfaces around the capabilities the platform actually needs.

## Provider categories in V1

The platform needs three primary provider categories:

1. Source Provider
2. Runtime Provider
3. PostgreSQL Provider

Additional categories such as DNS, storage, monitoring, billing, and email can be added later without changing the core deployment model.

## Common provider design rules

All provider adapters should follow these rules.

### 1. Provider IDs are persisted

Never infer external resources from names alone.

Persist:

- provider name
- provider resource ID
- provider operation ID where relevant
- reconciliation key

### 2. Writes must be reconcilable

Every create/update/delete operation must support one of:

- provider-native idempotency
- stable reconciliation key
- provider lookup by metadata/tag/name that is unique enough for recovery

If neither is possible, the operation is higher risk and must be explicitly accounted for in architecture.

### 3. Errors are normalized

Provider-specific errors must be translated into internal categories.

Examples:

```text
AUTHENTICATION_FAILED
PERMISSION_DENIED
RATE_LIMITED
RESOURCE_NOT_FOUND
CONFLICT
INVALID_CONFIGURATION
PROVIDER_UNAVAILABLE
TIMEOUT
QUOTA_EXCEEDED
UNKNOWN_PROVIDER_ERROR
```

Raw provider text may be stored in restricted diagnostic context but must not become the only error representation.

### 4. Provider timeouts are not immediate failures

A timeout may mean the request succeeded but the response was lost.

Provider write operations must therefore support an `OUTCOME_UNKNOWN` internal state and reconciliation.

### 5. Provider calls must be bounded

Every call must use:

- explicit timeout
- bounded retries
- failure classification
- structured logging without secret leakage

### 6. Provider-specific credentials are isolated

Credentials should be scoped by provider and purpose.

The public API process should not receive broad mutation credentials if only the worker needs them.

### 7. Adapters return normalized data

Core orchestration should not parse provider-specific response objects.

Adapters translate external responses into platform models.

## Source Provider interface

GitHub is the first V1 source provider, but the contract should remain conceptually generic.

### Responsibilities

- installation/account connection
- repository listing
- repository metadata
- branch resolution
- immutable revision lookup
- project tree inspection
- selected file retrieval
- webhook verification
- webhook normalization

### Conceptual interface

```text
interface SourceProvider {
  listRepositories(connection): RepositorySummary[]
  getRepository(repositoryId): RepositoryMetadata
  resolveRevision(repositoryId, branch): SourceRevision
  listTree(repositoryId, commitSha, options): TreeEntry[]
  readFile(repositoryId, commitSha, path): FileContent | NotFound
  verifyWebhook(headers, rawBody): VerifiedWebhook
  normalizeWebhook(verifiedWebhook): SourceEvent
}
```

### Normalized RepositorySummary

```text
provider_repository_id
owner
name
full_name
default_branch
is_private
```

### Normalized SourceRevision

```text
commit_sha
branch
commit_message
committed_at
```

### Source-provider rule

A branch name is never enough to identify deployment input.

The adapter must resolve it to an immutable commit SHA before analysis or deployment.

## Runtime Provider interface

This is the most important provider boundary in V1.

### Responsibilities

- create application runtime/project
- configure build/runtime settings
- configure environment variables/secrets
- trigger deployment/build
- query deployment status
- retrieve logs
- retrieve candidate URL
- delete runtime resources

### Conceptual interface

```text
interface RuntimeProvider {
  createRuntime(intent): RuntimeResource
  getRuntime(providerRuntimeId): RuntimeResource
  configureRuntime(providerRuntimeId, config): RuntimeConfigurationResult
  setEnvironment(providerRuntimeId, bindings): EnvironmentUpdateResult
  startDeployment(providerRuntimeId, revision, buildConfig): ProviderDeployment
  getDeployment(providerDeploymentId): ProviderDeploymentStatus
  getBuildLogs(providerDeploymentId, cursor?): LogBatch
  getRuntimeLogs(providerRuntimeId, cursor?): LogBatch
  getCandidateUrl(providerDeploymentId): UrlResult
  cancelDeployment(providerDeploymentId): CancellationResult
  deleteDeployment(providerDeploymentId): DeleteResult
  deleteRuntime(providerRuntimeId): DeleteResult
}
```

### Runtime creation intent

Core orchestration should pass a normalized intent such as:

```text
application_id
workspace_id
runtime_profile
region_preference
reconciliation_key
metadata_tags
```

The intent should not expose provider-specific configuration fields unless they are placed inside adapter-owned extension metadata.

### Runtime profile

V1 can define a very small set of platform runtime profiles.

Example:

```text
NEXTJS_STANDARD
NODE_STANDARD
```

A profile describes platform intent, not a provider SKU.

The adapter maps the profile to provider-specific implementation.

## Runtime deployment model

Normalized provider deployment status:

```text
PENDING
BUILDING
DEPLOYING
READY
FAILED
CANCELLED
UNKNOWN
```

The adapter maps provider states into these values.

The control-plane orchestrator then maps normalized provider status into the canonical deployment state machine.

This creates two layers:

```text
Provider Status
   -> Adapter Normalization
   -> Platform Deployment State
```

The provider never owns the platform state machine.

## Runtime logs contract

Normalized log record:

```text
timestamp
stream
level
message
source
cursor
```

Possible `stream` values:

```text
BUILD
RUNTIME
SYSTEM
```

Logs must be sanitized before persistence or user display.

Adapters should remove or mask known secret values when technically feasible, but the platform must also avoid injecting secrets into log-producing contexts unnecessarily.

## Runtime deletion contract

Deletion must be safe to retry.

Normalized result:

```text
DELETED
ALREADY_DELETED
PENDING
NOT_FOUND
FAILED
```

`NOT_FOUND` may be treated as successful reconciliation when platform intent is deletion and ownership has been verified.

## PostgreSQL Provider interface

### Responsibilities

- provision managed PostgreSQL
- query provisioning status
- provide application connection binding
- expose safe metadata
- delete database
- later support backup/restore if the product claims those capabilities

### Conceptual interface

```text
interface PostgresProvider {
  createDatabase(intent): DatabaseResource
  getDatabase(providerDatabaseId): DatabaseStatus
  getConnectionBinding(providerDatabaseId): ConnectionBinding
  deleteDatabase(providerDatabaseId): DeleteResult
}
```

### Database creation intent

Normalized intent:

```text
workspace_id
application_id
region_preference
resource_profile
reconciliation_key
metadata_tags
```

Again, `resource_profile` is a platform concept, not a provider plan name.

Example V1 profile:

```text
POSTGRES_SMALL
```

The adapter maps this to provider-specific sizing.

## Connection binding contract

The database adapter should not return a casually serializable generic object containing secrets that may leak into logs.

Conceptually:

```text
ConnectionBinding {
  secret_material_handle
  metadata
}
```

The worker passes the sensitive value directly into the secrets/configuration path.

Safe metadata may include:

```text
host_masked
port
ssl_required
database_name
provider_resource_id
```

## Existing database mode

Existing database mode does not use a provisioning adapter.

The platform stores the user-provided database secret and binds it to the application.

This path must remain first-class because existing applications such as internal proof workloads may already have databases.

## Future provider categories

The architecture should allow future interfaces such as:

```text
DnsProvider
StorageProvider
BackupProvider
MetricsProvider
EmailProvider
BillingProvider
```

Do not implement interfaces before the product needs them.

## Provider capability declaration

Each adapter should expose capabilities so orchestration does not assume unsupported features.

Conceptually:

```text
capabilities() -> {
  supportsCancellation
  supportsRuntimeLogs
  supportsBuildLogs
  supportsCustomDomains
  supportsRegions
  supportsNativeIdempotency
  supportsManagedBackups
}
```

This allows the control plane to alter behaviour safely without provider-specific conditionals everywhere.

## Provider adapter versioning

Provider APIs evolve.

Each adapter should expose an internal adapter version.

Persisting adapter version on operations/deployments where useful can help incident debugging later.

Example:

```text
runtime_provider = "provider-x"
runtime_adapter_version = "1.3.0"
```

This is not required in every table but should be available in diagnostic context.

## Provider operation contract

Every mutation should create or reference a provider operation record before execution where appropriate.

Conceptual flow:

```text
Create provider_operation row
  status = PENDING
  idempotency_key = generated

Call adapter

If success:
  status = SUCCEEDED
  persist provider reference

If classified permanent failure:
  status = FAILED

If timeout/uncertain network outcome:
  status = OUTCOME_UNKNOWN
  trigger reconciliation
```

## Reconciliation interface

Provider adapters must offer enough read capability to resolve uncertain writes.

Conceptually:

```text
findRuntimeByReconciliationKey(key)
findDatabaseByReconciliationKey(key)
findDeploymentByReconciliationKey(key)
```

Where provider APIs do not support direct key lookup, adapters may implement reconciliation using tags, deterministic names, or provider-specific metadata.

The important point is that reconciliation logic stays inside the adapter.

## Provider health and circuit breaking

The platform should not hammer a failing provider.

V1 should support basic provider health awareness.

Possible internal states:

```text
HEALTHY
DEGRADED
UNAVAILABLE
```

Signals may include:

- repeated 5xx responses
- repeated timeouts
- provider status indicators where available
- elevated rate-limit responses

When a provider is clearly unavailable, orchestration should delay/retry safely rather than create a retry storm.

A sophisticated distributed circuit breaker is not required initially; bounded backoff and shared provider-health signals are sufficient for V1.

## Rate-limit handling

Adapters must normalize rate-limit information when providers expose it.

Possible normalized fields:

```text
retry_after
limit
remaining
reset_at
```

Workers should respect provider guidance and use queue rescheduling rather than sleeping for long periods inside a worker process.

## Region abstraction

V1 should not promise arbitrary region selection unless supported end to end.

Use a normalized region preference abstraction.

Example:

```text
AUTO
INDIA_NEAR
EUROPE_NEAR
US_NEAR
```

However, even these labels should only be exposed if provider capability and product behaviour are validated.

For earliest V1, `AUTO` is sufficient.

## Provider metadata tagging

Where supported, every externally created resource should receive platform metadata such as:

```text
platform = small-software-cloud
workspace_id = ...
application_id = ...
deployment_id = ... when relevant
reconciliation_key = ...
```

This materially improves reconciliation, support, and cleanup.

Never put secrets or sensitive customer information in provider tags.

## Error normalization

Suggested internal error model:

```text
ProviderError {
  category
  provider
  operation
  retryable
  outcome_known
  safe_message
  diagnostic_reference
}
```

### Example

Provider returns a 429.

Adapter returns:

```text
category = RATE_LIMITED
retryable = true
outcome_known = true
safe_message = "Infrastructure provider rate limit reached. Retrying shortly."
```

Provider request times out after resource creation may have happened.

Adapter returns:

```text
category = TIMEOUT
retryable = false initially
outcome_known = false
safe_message = "Provider response was not confirmed. Checking resource state."
```

The orchestrator does not blindly retry until reconciliation resolves uncertainty.

## Testing strategy for adapters

Each provider adapter should have three test layers.

### 1. Contract tests

Verify normalized behaviour independent of live provider.

Examples:

- status mapping
- error mapping
- capability reporting
- safe serialization

### 2. Sandbox/integration tests

Use actual provider APIs in a controlled account to verify:

- create
- configure
- deploy
- query
- delete
- reconciliation

### 3. Failure-path tests

Simulate or induce:

- timeout
- rate limit
- duplicate create attempt
- delete of already deleted resource
- authentication failure
- partial configuration failure

A provider adapter is not considered production-ready if only the happy path works.

## Vendor lock-in principle

The goal is not theoretical portability.

Some provider-specific advantages may be intentionally used.

The rule is:

> Provider-specific optimization is allowed inside the adapter. Provider-specific assumptions must not become control-plane invariants unless explicitly accepted as an architecture decision.

## V1 implementation expectation

V1 will likely have:

```text
GitHubSourceAdapter
PrimaryRuntimeAdapter
PrimaryPostgresAdapter
```

Only one runtime and one managed PostgreSQL provider need to be production-supported initially.

The interfaces exist so we can replace or add providers later without rewriting orchestration.

## Quality gate for provider interfaces

Before Node 02 is complete, confirm:

1. Core orchestration can be understood without naming a vendor.
2. Every provider mutation is reconcilable.
3. Timeouts are distinguishable from confirmed failures.
4. Provider errors map to internal categories.
5. Provider status does not directly become platform deployment status.
6. Credentials are scoped and isolated.
7. Logs do not expose secret material.
8. Deletion is safe to retry.
9. Provider capability differences are explicit.
10. Resource ownership metadata supports cleanup and incident investigation.

## Decision

Small Software Cloud V1 will use narrow provider interfaces for source, runtime, and managed PostgreSQL capabilities.

The platform control plane owns orchestration semantics, deployment state, lifecycle, error categories, and recovery behaviour.

Provider adapters own translation into vendor-specific APIs and reconciliation mechanisms.

The next Node 02 document should define the secrets architecture, because provider abstraction only remains safe if secret storage, decryption, injection, logging, and rotation boundaries are explicit from the beginning.
