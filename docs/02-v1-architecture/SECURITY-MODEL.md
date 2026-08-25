# Node 02 - V1 Security Model

## Purpose

This document defines the V1 security model for Small Software Cloud.

The platform will eventually execute third-party code and therefore must assume customer repositories and workloads may be buggy, compromised, or intentionally hostile.

The governing principle is:

> Customer code is untrusted. Control-plane credentials, tenant data, and other workloads must remain outside its reach.

## Security objectives

V1 security is designed around these outcomes:

1. one tenant cannot access another tenant's data or resources
2. customer workloads cannot access control-plane credentials
3. repository analysis does not execute customer code
4. builds/runtime execution occur only inside isolation provided by approved infrastructure primitives
5. resource consumption is bounded
6. provider credentials are least privilege
7. secrets remain encrypted and scoped
8. destructive actions are authorized and auditable
9. abuse can be rate-limited, suspended, and investigated
10. external users are not allowed until the architecture has passed explicit security review

## Trust boundaries

The system has five primary trust zones.

```text
1. User browser / API client
2. Control Plane Web/API
3. Background Worker
4. Infrastructure Providers
5. Customer Workload
```

The customer workload is the least trusted zone.

### User browser / API client

Untrusted input source.

May submit:
- repository choices
- configuration
- secrets
- deployment commands

Every request requires authentication, authorization, input validation, and rate limiting where appropriate.

### Control Plane Web/API

Trusted platform component, but internet-facing.

Should hold only credentials required for:
- control-plane database
- session/auth
- queue submission
- limited GitHub integration flows

It should not hold broad provider mutation credentials when those can be worker-only.

### Background Worker

Trusted higher-sensitivity platform component.

May require:
- runtime provider mutation access
- database provisioning access
- temporary secret decryption capability

It should not expose a public application interface.

### Infrastructure Providers

Trusted for the specific primitives they provide, but still external dependencies.

Provider compromise/outage must not automatically imply cross-tenant control-plane compromise.

### Customer Workload

Untrusted execution.

Must never receive:
- control-plane DB credentials
- queue credentials
- GitHub App private key
- runtime provider admin credentials
- database provisioning credentials
- another app's secrets
- another workspace's secrets

## Threat model

The V1 threat model includes both accidental and malicious behaviour.

### Repository threats

- malicious package scripts
- huge files / parser denial of service
- crafted source to exploit analyzer parsers
- deceptive environment-variable patterns
- dependency confusion or compromised dependencies
- malicious native packages

### Runtime threats

- cryptomining
- spam
- network scanning
- credential theft attempts
- abuse of outbound network
- excessive CPU/memory/storage
- fork bombs / runaway processes
- malicious dependency execution
- attempts to escape isolation

### Control-plane threats

- broken tenant authorization
- IDOR / object ownership bugs
- secret leakage through logs
- privilege escalation
- webhook forgery
- provider credential theft
- queue replay/duplicate execution
- unsafe deletion
- SQL injection / application injection bugs

### Operational threats

- stolen developer credentials
- leaked environment files
- insecure CI secrets
- accidental broad GitHub/provider permissions
- debugging logs exposing customer information

## Tenant isolation

Every user-facing operation must be authorized against workspace ownership.

Never trust an entity ID alone.

Pattern:

```text
request application_id
  -> load application scoped by workspace_id
  -> verify membership/role
  -> perform action
```

Avoid:

```text
load application by application_id
  -> assume current user may access it
```

### Database isolation

All tenant-owned records must have explicit or unambiguous workspace ownership.

Where practical, security-sensitive queries should include workspace scope directly.

Application-layer authorization is mandatory even if database-level policies are later added.

## Authentication

V1 should use a mature authentication provider/library rather than custom password cryptography.

Security requirements:

- secure session cookies/tokens
- CSRF protection where relevant
- secure logout/session invalidation
- account recovery through provider capabilities
- MFA support can follow when product requirements justify it

Do not build custom password storage unless absolutely necessary.

## Authorization

V1 roles remain intentionally simple:

```text
OWNER
MEMBER
```

Sensitive actions should be owner-only initially where appropriate.

Examples:

- delete workspace
- remove final owner
- high-impact billing/security settings later

Application deploy/configure permissions can remain workspace-member accessible initially if this fits alpha usage.

## GitHub security

Follow the GitHub Integration specification.

Key requirements:

- GitHub App, not user PATs
- read-only contents access
- exact commit pinning
- verified webhook signatures
- duplicate webhook safety
- revocable installation access
- no source write access in V1

Repository source is confidential customer data and must not be logged or retained unnecessarily.

## Analyzer security

The analyzer is a parser, not an executor.

It must not run:

- npm install
- lifecycle scripts
- project code
- shell scripts
- framework builds

Use bounded static parsing with:

- file-size limits
- cumulative-byte limits
- parse timeouts
- safe parsers
- binary skipping
- path sanitization

Any parser library used against hostile input becomes part of the attack surface and should be kept patched.

## Build isolation

Builds execute customer dependencies and scripts and are therefore hostile-code execution.

V1 should delegate build execution to infrastructure that provides isolation appropriate for third-party code.

The control plane must not execute customer builds on the same host/process as control-plane services.

Required properties before external alpha:

- isolated build environment
- CPU/memory/time limits
- no control-plane credentials present
- no direct access to control-plane database/network
- only intended application secrets exposed
- temporary filesystem/workspace lifecycle understood

## Runtime isolation

Customer runtime must be isolated by the selected provider primitive.

Before external alpha, validate:

- workload cannot access host/control plane
- tenant workloads do not share credentials
- CPU/memory/runtime limits exist
- provider has credible isolation model for untrusted workloads
- workload lifecycle can be terminated reliably

If the selected provider's isolation model is intended only for trusted first-party code, it is not sufficient for arbitrary external code.

## Network security

### Inbound

Customer workload receives only provider-exposed application endpoints.

Control-plane internal services should not be exposed to customer workload networks unnecessarily.

### Outbound

V1 should understand the runtime provider's outbound-network controls and abuse posture.

At minimum:

- control-plane/private metadata endpoints must not be reachable from customer workloads
- provider credentials must not be discoverable via instance metadata
- platform should be able to suspend workloads involved in abuse

Fine-grained egress allowlists may come later if provider model supports them and demand justifies complexity.

## SSRF considerations

Health verification and any future fetch/proxy capability must not permit arbitrary access to internal network targets.

Health verifier should:

- only target the candidate deployment URL
- validate scheme/host
- block private/internal address ranges where appropriate
- limit redirects
- revalidate redirect targets
- use short timeouts
- cap response sizes

## Secrets security

Follow the Secrets Architecture.

Additional controls:

- secrets encrypted before persistence
- encryption master key separate from DB
- worker-only decryption where feasible
- secrets omitted from logs/events/queue
- tenant ownership verified before secret resolution
- provider environment injection only for target application

## Provider credentials

Provider credentials are platform crown jewels.

Use separate credentials by purpose/provider where practical.

Example:

```text
GitHub App credential
Runtime provider mutation credential
Postgres provisioning credential
KMS/decryption identity
```

Avoid one global credential with unnecessary permissions across every provider.

## Least privilege

Each deployable component should receive only required permissions.

### API

Allowed:
- control-plane DB application access
- queue submission
- GitHub read/token flow as required

Not needed:
- runtime provider admin credential
- database provisioning credential
- broad secret decryption if architecture can avoid it

### Worker

Allowed:
- queue consumption
- required DB access
- provider mutations
- narrowly scoped secret decryption

### Customer workload

Allowed:
- its own runtime environment
- its own configured external services

Nothing else from the platform.

## Resource limits

Every external workload must have bounded resource usage.

At minimum understand/enforce:

- CPU limit
- memory limit
- execution timeout where applicable
- storage limits where applicable
- build timeout
- deployment concurrency
- account/workspace deployment rate

Free/alpha tiers especially require conservative limits to reduce abuse risk and cost exposure.

## Abuse prevention

The platform must anticipate abuse such as:

- cryptomining
- phishing
- malware hosting
- spam
- botnet/control infrastructure
- network scanning
- denial-of-service traffic generation

V1 controls should include:

- account-level rate limits
- deployment limits
- resource caps
- provider abuse notifications monitored
- ability to suspend application/workspace
- ability to revoke runtime resources quickly
- audit trail

Sophisticated automated abuse detection can evolve later.

## Emergency suspension

V1 requires an operator capability to:

```text
SUSPEND APPLICATION
```

or

```text
SUSPEND WORKSPACE
```

Suspension should:

- stop new deployments
- disable/revoke runtime exposure where provider supports it
- preserve evidence/audit records
- avoid destructive deletion unless separately requested

This is an abuse/safety control, not normal deletion.

## Rate limiting

Apply rate limits to sensitive/public surfaces such as:

- login/auth attempts
- deployment creation
- repository analysis requests
- secret updates
- webhook endpoints where meaningful after signature verification
- API endpoints later exposed to agents

Rate limits should consider workspace/account, not only IP address.

## Input validation

Validate all identifiers and user-controlled strings.

Examples:

- app names/slugs
- environment keys
- branch names
- root directory
- domain values later
- configuration sizes

Never interpolate user-controlled values into shell commands.

## SQL/database security

Use parameterized queries/ORM safely.

Control-plane DB should:

- not be public internet exposed unless provider architecture securely requires it
- use TLS
- use separate production credentials
- have backups
- restrict access to control-plane components

Customer workloads must never connect to the control-plane DB.

## CSRF / browser security

For cookie-authenticated mutations, use framework/provider-appropriate CSRF protection.

Use:

- secure cookies
- HttpOnly
- SameSite strategy
- HTTPS only
- sensible CSP and security headers

Exact implementation belongs to Technology Decisions.

## Webhook security

Every webhook provider integration must verify authenticity before processing.

For GitHub:

- raw body
- HMAC signature
- constant-time compare
- delivery dedupe

Never accept unsigned webhook payloads because they "look valid".

## Dependency security

Control-plane dependencies are trusted code and require routine maintenance.

V1 practices:

- lockfiles committed
- automated dependency vulnerability alerts/scanning
- avoid abandoned high-risk packages
- patch critical vulnerabilities promptly
- minimize dependency count for security-sensitive modules

## Supply-chain security

CI/CD should protect:

- repository write access
- deployment credentials
- provider credentials
- production environment variables

Production deployment should come from protected repository branches/processes once the team expands.

## Logging and privacy

Logs should contain identifiers and operational metadata, not source code or secrets.

Prefer:

```text
workspace_id
application_id
deployment_id
request_id
error category
```

Avoid:

```text
raw secrets
full repository files
customer DB contents
sensitive headers
```

## Auditability

Audit high-impact actions:

- GitHub connection/disconnection
- application creation
- secret create/update/delete
- deploy/redeploy
- suspension
- application deletion
- membership changes
- provider credential/config changes by operators later

Audit metadata must be safe and non-secret.

## Safe deletion

Deletion must be authorized, asynchronous, and auditable.

Requirements:

- prevent accidental cross-tenant deletion
- enumerate owned resources
- revoke credentials
- delete runtime resources
- handle DB deletion only according to explicit policy/confirmation
- reconcile provider state
- preserve non-sensitive audit history

## Soft-delete security

Soft deletion preserves operational records but should not keep unnecessary secret material.

Secrets require separate retention/destruction policy.

## Backups and encryption

Control-plane backups may include encrypted customer secrets.

The encryption master key remains separate.

Production backup access should be tightly restricted.

Restore procedures must not expose secrets in temporary environments without equivalent security controls.

## Admin/operator access

Founders/operators will initially have broad platform access, which is a risk.

Mitigations:

- no routine plaintext secret reveal tooling
- separate production credentials
- audit privileged actions where practical
- use MFA on GitHub/cloud/provider accounts
- do not share credentials casually
- remove access immediately when no longer required

As the team grows, introduce role separation and just-in-time privileged access where warranted.

## Security headers and HTTPS

Control plane must be HTTPS-only in production.

Implement appropriate:

- HSTS when safe
- Content-Security-Policy
- X-Content-Type-Options
- frame protection
- Referrer-Policy

Exact policy must be tested against authentication/integration flows.

## Vulnerability reporting

Before public beta, publish a basic responsible security contact/process.

A full bug bounty is not required early.

There must be a way for researchers/users to report vulnerabilities privately.

## Incident response

Before external alpha, document a simple incident procedure:

1. contain
2. suspend affected component/workload
3. preserve logs/audit evidence
4. rotate affected credentials
5. assess tenant scope
6. notify affected parties when legally/contractually required
7. fix root cause
8. document lessons/actions

## Security review checkpoint

A specialist security/infrastructure review is mandatory before arbitrary external customer code is allowed to execute.

The review should assess at least:

- selected build/runtime provider isolation model
- control-plane vs workload boundaries
- provider credential scopes
- secret architecture
- tenant authorization model
- webhook security
- SSRF risks
- deletion/suspension paths
- network exposure
- resource/abuse limits

This can be a focused specialist engagement rather than a full-time hire.

## External-alpha admission rule

Do not open unrestricted self-service external deployment until:

- security architecture implemented
- isolation provider validated
- resource limits confirmed
- suspension controls working
- core authorization tests passing
- secret leakage tests passing
- security review completed

Early external alpha may initially be invite-only/manual approval even after the technical gate passes.

## Security testing requirements

Before external alpha, test:

### Authorization

- user A cannot read/update/delete workspace B app
- user A cannot use workspace B secret ID
- guessed IDs do not bypass ownership checks

### Secrets

- API never returns plaintext
- logs/queue/events omit plaintext
- wrong tenant cannot decrypt/bind secret

### GitHub

- forged webhook rejected
- removed repository access respected
- source code never executes in analyzer

### Workload isolation

- workload cannot reach control-plane DB
- workload cannot read provider admin credentials
- workload cannot access another app's variables
- resource limits behave as expected

### Abuse controls

- repeated deployment requests rate limited
- suspended app cannot continue normal deployment lifecycle

### Deletion

- deleting app A cannot delete app B resource
- repeated delete is safe

## Security invariants

These are zero-tolerance invariants:

```text
Cross-tenant data exposure = 0
Cross-tenant secret exposure = 0
Customer access to control-plane credentials = 0
Unsigned webhook acceptance = 0
Untrusted repository execution in analyzer = 0
Untracked privileged provider mutation = 0
```

## V1 security posture

V1 deliberately avoids owning low-level hostile-code isolation.

Instead:

```text
Small Software Cloud owns:
- tenant authorization
- orchestration security
- secret handling
- credential boundaries
- auditability
- resource policy
- abuse/suspension controls

Managed infrastructure owns:
- low-level build/runtime sandboxing
- host/kernel isolation
- physical network/compute security
```

We remain responsible for selecting provider primitives appropriate to untrusted external workloads.

## Quality gate

Before this model is considered ready for implementation:

1. all trust boundaries are explicit
2. tenant authorization pattern is defined
3. analyzer never executes code
4. build/runtime isolation is delegated only to approved primitives
5. worker/API credentials are separated
6. customer runtime receives no platform credentials
7. secrets remain isolated and encrypted
8. abuse/suspension controls exist in V1 design
9. health checks cannot become SSRF primitives
10. destructive actions are authorized/audited
11. external-alpha security review is mandatory
12. zero-tolerance invariants have automated tests where possible

## Decision

Small Software Cloud V1 will treat all customer code as untrusted and will not expose arbitrary external deployment until tenant isolation, secret handling, provider isolation, resource controls, suspension, and core authorization have been implemented and independently reviewed.

The next Node 02 document should define Technology Decisions: the actual V1 stack and managed providers chosen for the control plane, queue/workflow, runtime, PostgreSQL, authentication, secrets/KMS, observability, DNS, and deployment tooling, with explicit cost and portability rationale.
