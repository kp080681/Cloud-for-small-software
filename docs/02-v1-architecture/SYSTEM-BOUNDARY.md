# Node 02 - V1 System Boundary

## Purpose

This document defines what Small Software Cloud owns in V1 and what remains the responsibility of underlying infrastructure providers.

This boundary is intentionally conservative. The goal is to own the orchestration and control plane while delegating commodity infrastructure primitives to mature providers.

The governing principle is:

> Own the control plane before owning the compute plane.

## Why this boundary matters

If the platform owns too little, it becomes a thin hosting reseller with limited differentiation.

If the platform owns too much too early, it inherits infrastructure complexity, security risk, operational burden, and fixed cost before demand is proven.

V1 therefore owns the user experience, application understanding, deployment intent, state, orchestration, and recovery logic while delegating physical execution primitives.

## Small Software Cloud owns

### 1. Accounts and workspaces

The platform owns:

- user accounts
- workspaces / organisations
- application ownership
- membership and future team access
- application-level permissions

The platform must always know which customer owns which application and which infrastructure resources belong to that application.

### 2. GitHub connection

The platform owns:

- GitHub installation state
- repository selection
- branch and commit identity
- webhook handling
- source metadata
- repository access decisions

GitHub remains the source provider. The platform does not become a source-control system.

### 3. Repository analysis

The platform owns application understanding for supported V1 workloads.

This includes:

- framework detection
- Node.js runtime detection
- package manager detection
- install command detection
- build command detection
- start behaviour detection where relevant
- environment variable discovery
- PostgreSQL requirement detection
- compatibility verdict
- unsupported dependency detection

The output is a deployment plan, not merely raw repository metadata.

### 4. Compatibility decision

The platform owns the decision to classify a repository as:

- SUPPORTED
- NEEDS_CONFIGURATION
- UNSUPPORTED

The platform must not attempt arbitrary best-effort deployments for workloads outside the declared V1 compatibility boundary.

### 5. Deployment plan

The platform owns the canonical deployment plan describing:

- source commit
- detected framework/runtime
- build configuration
- required secrets
- database mode
- runtime target
- application URL intent
- deployment sequence

This plan becomes the input to orchestration.

### 6. Secrets orchestration

The platform owns:

- collecting secrets from the user
- validating required secret presence
- encrypting stored secrets or storing secure provider references
- deciding which deployment receives which secret
- secret rotation/revocation workflows where the platform controls the credential
- preventing secrets from being written back to source control

The platform must never expose another tenant's secrets.

### 7. Deployment state

The platform owns the deployment state machine.

At minimum, deployment state must distinguish:

- CREATED
- ANALYSING
- AWAITING_CONFIGURATION
- READY
- PROVISIONING
- BUILDING
- DEPLOYING
- VERIFYING
- LIVE
- FAILED
- DELETING
- DELETED

Provider-specific statuses must be translated into the platform's canonical state model.

### 8. Infrastructure orchestration

The platform owns the decision and sequence for provisioning infrastructure.

Examples:

- create application runtime
- create database when required
- inject environment variables
- connect source/build configuration
- trigger build
- assign or retrieve application URL
- verify deployment
- retry safe operations
- clean up failed resources

The platform controls the workflow even when providers perform the physical work.

### 9. Provider abstraction

The platform owns provider adapter interfaces.

Control-plane logic should call platform-level capabilities such as:

- createRuntime()
- deployApplication()
- createDatabase()
- setSecrets()
- getDeploymentStatus()
- getLogs()
- deleteResource()

Core product logic should not be tightly coupled to a single provider's API shape.

Provider adapters may initially be thin, but the boundary must exist from V1.

### 10. Health verification

The platform owns the definition of successful deployment.

A provider reporting a successful build is not enough.

The platform must independently verify, at minimum where technically feasible:

- URL resolves
- TLS works
- expected HTTP response is received
- application is not in an immediate crash loop

A deployment becomes LIVE only after verification succeeds.

### 11. Logs presentation

The platform owns the user-facing operational view of:

- deployment events
- build logs
- runtime logs where available
- health-check failure information

Providers may generate the underlying logs. The platform owns normalising and presenting enough information to answer:

> Why did this deployment fail?

### 12. Redeployment

The platform owns redeployment intent and lifecycle.

A redeploy must create a new deployment record tied to a known source revision and configuration state.

Redeployment must not silently mutate the history of a previous deployment.

### 13. Deletion

The platform owns safe deletion orchestration.

Deletion includes:

- mark application as deleting
- revoke or remove platform-owned credentials
- delete platform-owned runtime resources
- delete platform-owned database resources when explicitly requested
- reconcile provider deletion status
- mark application deleted only after owned resources are accounted for

Deletion must be auditable and designed to avoid orphan resources.

### 14. Audit trail

The platform owns an immutable or append-oriented operational record sufficient to explain important actions.

Examples:

- repository connected
- secret changed
- deployment requested
- resource provisioned
- deployment failed
- deployment retried
- application deleted

The control plane must be able to reconstruct what happened without relying entirely on transient provider logs.

### 15. Customer-facing failure translation

The platform owns translating infrastructure failures into understandable actions.

Instead of only returning provider error text, the platform should progressively classify failures into actionable categories such as:

- missing environment variable
- unsupported runtime
- dependency install failure
- build failure
- database connection failure
- health-check failure
- provider unavailable

V1 does not require AI auto-repair. It does require understandable failure states.

## Infrastructure providers own

### 1. Physical compute

Providers own the servers, virtual machines, containers, functions, or other physical execution substrate used by V1.

Small Software Cloud does not purchase or operate physical servers for V1.

### 2. Workload runtime isolation

Providers own the low-level isolation mechanism that separates customer workloads from hosts and, where applicable, other workloads.

Small Software Cloud remains responsible for selecting provider architectures that offer an isolation level appropriate for the workload risk.

Delegating the mechanism does not delegate responsibility for the architecture decision.

### 3. Host operating-system security

Providers own:

- host patching
- kernel maintenance
- hypervisor/container-host maintenance
- physical host security

Small Software Cloud must not require host-level administrative access in V1.

### 4. Core network infrastructure

Providers own the physical and virtual networking primitives needed to deliver applications.

This may include:

- routing
- load balancing
- network interfaces
- edge networking
- basic DDoS protections

Small Software Cloud owns orchestration and configuration intent, not the underlying network fabric.

### 5. TLS termination infrastructure

Providers may own certificate issuance, renewal, and TLS termination machinery.

Small Software Cloud owns the product experience that ensures an application receives a working HTTPS URL.

### 6. DNS infrastructure

Providers may own DNS hosting and propagation machinery.

Small Software Cloud owns the mapping between an application and its assigned domain/subdomain and later the custom-domain workflow.

### 7. PostgreSQL engine

Database providers own:

- PostgreSQL process/runtime
- database host maintenance
- engine patching
- physical storage substrate
- replication primitives offered by the provider

Small Software Cloud owns provisioning, association with an application, credential handling, lifecycle intent, and customer experience.

### 8. Storage primitives

Where object/file storage is introduced, providers own the physical storage engine and durability primitives.

The platform owns resource association, access configuration, and lifecycle orchestration.

### 9. Provider-level monitoring

Providers may generate infrastructure metrics and logs.

Small Software Cloud owns which signals matter to the product and how they are surfaced to users.

### 10. Physical redundancy

V1 relies on provider-level infrastructure redundancy rather than building its own multi-datacenter or multi-region physical architecture.

The platform may later add provider/region failover only when customer requirements and economics justify it.

## Shared-responsibility areas

Some responsibilities cannot be cleanly delegated.

### Security

Provider responsibility:
- secure underlying infrastructure
- maintain runtime/host isolation mechanisms

Small Software Cloud responsibility:
- choose safe provider primitives
- prevent tenant credential crossover
- enforce least-privilege provider credentials
- avoid unsafe network exposure
- enforce resource lifecycle boundaries
- review architecture before arbitrary external code is allowed

### Availability

Provider responsibility:
- availability of underlying primitives according to provider commitments

Small Software Cloud responsibility:
- not introducing avoidable control-plane outages
- recovering correctly from provider failures
- maintaining canonical deployment state
- avoiding synchronous dependencies in the customer request path

### Performance

Provider responsibility:
- runtime, database, network, and region performance

Small Software Cloud responsibility:
- avoid unnecessary proxy hops
- avoid placing the control plane in the normal application request path
- choose sensible regions/resources
- keep control-plane operations responsive

### Backups

Provider responsibility:
- supply backup/snapshot primitives where selected

Small Software Cloud responsibility:
- decide whether backup is enabled
- expose backup state
- associate backups with applications/databases
- test restore workflows before claiming backup capability

## Runtime request-path principle

Once an application is live, normal end-user traffic should not pass through the Small Software Cloud control plane unless a future feature absolutely requires it.

Preferred path:

```text
End User
   -> Runtime Provider
   -> Customer Application
   -> Customer Database / Services
```

Avoid:

```text
End User
   -> Small Software Cloud Control Plane
   -> Runtime Provider
   -> Customer Application
```

This protects latency, availability, scale, and tenant isolation.

The control plane orchestrates applications. It should not become a mandatory reverse proxy for them in V1.

## V1 boundary summary

```text
SMALL SOFTWARE CLOUD

Owns:
- identity/workspaces
- GitHub orchestration
- repository understanding
- compatibility decision
- deployment plan
- secrets orchestration
- deployment state machine
- provider orchestration
- health verification
- user-facing logs/status
- redeploy/delete
- audit trail
- failure translation

Delegates:
- physical compute
- low-level workload isolation
- host operating systems
- PostgreSQL engine
- physical network
- TLS machinery
- DNS machinery
- storage primitives
- physical redundancy
```

## Explicit V1 non-ownership

Small Software Cloud will not initially own:

- physical servers
- hypervisors
- Kubernetes clusters
- custom container scheduler
- custom microVM runtime
- PostgreSQL engine
- global edge network
- certificate authority
- DNS engine
- object storage engine
- multi-region failover system

These may become strategic infrastructure layers later only when revenue, security, performance, or gross-margin economics justify ownership.

## Boundary test

Before adding any new V1 infrastructure responsibility, ask:

> Does owning this layer materially improve deployment reliability, security, user experience, portability, or economics today?

If the answer is no, delegate it.

## Decision

V1 will be a control-plane and orchestration product built on mature infrastructure providers.

The company will own the system of record, deployment intent, application understanding, lifecycle, recovery logic, and developer experience.

It will not initially own the physical compute or data infrastructure underneath customer workloads.

This boundary is the baseline for the remainder of Node 02.
