# Node 02 - V1 Secrets Architecture

## Purpose

This document defines how Small Software Cloud V1 stores, accesses, injects, rotates, logs, and deletes customer secrets.

The security objective is simple:

> A customer secret must never become ordinary application data inside the control plane.

Secrets include:

- database connection strings
- API keys
- OAuth client secrets
- email provider credentials
- AI provider keys
- private tokens
- service credentials
- encryption-related application secrets

## Core principles

1. Secrets are encrypted at rest.
2. Plaintext is revealed only for a narrowly scoped execution need.
3. Secret values never appear in normal API responses after creation.
4. Secret values never appear in queue payloads.
5. Secret values never appear in logs, events, analytics, or audit metadata.
6. Customer runtimes receive only their own application-specific secrets.
7. Customer runtimes never receive control-plane credentials.
8. Secret access is auditable.
9. Secret deletion and rotation are first-class lifecycle operations.
10. A worker should not retain plaintext longer than necessary.

## Secret lifecycle

```text
User enters secret
  -> API validates request
  -> value encrypted
  -> encrypted material/reference stored
  -> metadata stored separately
  -> secret binding created
  -> deployment plan references secret binding/version metadata
  -> worker decrypts only when required
  -> provider environment configured
  -> plaintext discarded from worker memory as soon as practical
```

## Secret metadata vs secret material

The platform should separate metadata from encrypted material.

### Metadata

Safe to expose in masked form:

```text
secret_id
workspace_id
name
status
created_at
updated_at
rotated_at
last_used_at
```

Optional safe fingerprint metadata:

```text
last_four
length_class
provider_type_hint
```

Only if genuinely useful and not sensitive.

### Secret material

Never returned after creation.

Stored as one of:

```text
encrypted ciphertext
```

or

```text
reference to managed secret store
```

V1 should prefer the simplest secure approach compatible with the selected platform and budget.

## Encryption model

V1 should use envelope-style encryption or a managed KMS/secret-store primitive rather than inventing cryptography.

Conceptually:

```text
plaintext secret
  -> data encryption key
  -> ciphertext
  -> data key encrypted/protected by master key/KMS
```

The control plane database stores only encrypted material plus key/version metadata.

### Master key rule

The master encryption key must not be stored in the same database as encrypted customer secrets.

It should live in:

- managed KMS
- managed secrets service
- infrastructure secret store

## Encryption context

Where the chosen primitive supports authenticated context, bind encryption/decryption to tenant/application metadata such as:

```text
workspace_id
secret_id
```

This reduces the risk of ciphertext being copied between tenants and successfully decrypted in the wrong context.

## API write path

When a user creates or updates a secret:

1. authenticate user
2. verify workspace/application authorization
3. validate key name and value size
4. encrypt immediately
5. persist encrypted material/reference
6. persist metadata
7. create/update binding
8. emit safe audit event
9. remove plaintext from request-scoped variables as soon as practical

### API response

Return only masked metadata.

Example:

```text
OPENAI_API_KEY
Configured
Updated 2026-08-25
```

Never return the original value.

## Read path

Normal user-facing APIs do not provide secret plaintext.

The dashboard can answer:

- configured/not configured
- last updated
- scope
- environment

But not:

- actual value

If users need to change a secret, they replace it.

## Worker access path

The background worker may decrypt a secret only when a deployment/configuration operation requires it.

Conceptual flow:

```text
worker receives deployment_id
  -> loads deployment plan
  -> resolves required secret IDs/version metadata
  -> verifies application/workspace ownership
  -> requests decrypt
  -> injects plaintext into provider environment
  -> discards plaintext
```

### Critical rule

The worker should receive only the secrets required for that specific application/deployment operation.

Not every secret in the workspace.

## Separation of credentials

There are three very different secret classes.

### 1. Customer application secrets

Examples:

- OPENAI_API_KEY
- RESEND_API_KEY
- application DATABASE_URL

These may be injected into customer runtime.

### 2. Control-plane infrastructure credentials

Examples:

- runtime provider admin token
- database provider provisioning token
- queue credential
- control-plane database credential

These must never be injected into customer runtime.

### 3. Integration credentials

Examples:

- GitHub App private key/token material

These must remain isolated to the component that requires them.

The codebase and deployment environment should make these classes visibly distinct.

## Worker privilege model

The worker is a higher-sensitivity component than the public API.

The worker may require:

- decrypt capability for customer secrets
- provider mutation credentials

Therefore:

- it should have no general public inbound endpoint
- access should be least privilege
- credentials should be separated by provider where practical
- worker logs require aggressive redaction

## Secret binding model

Secrets are not directly attached to deployment rows as plaintext.

Instead:

```text
secret
  -> secret_binding
      -> application/environment/key
```

A deployment plan snapshots binding/version identifiers, not secret values.

This preserves deployment history without exposing sensitive data.

## Environments

V1 may support only production initially.

Still model bindings with an environment field:

```text
PRODUCTION
```

This prevents future schema churn when preview/staging environments are introduced.

## Managed secrets

Some values are created by the platform rather than entered by the user.

Example:

```text
DATABASE_URL from managed PostgreSQL
```

These should follow the same secret handling path as user-provided credentials.

The difference is source metadata:

```text
source = PLATFORM_MANAGED
```

## Logging policy

Plaintext secrets must never be written to:

- application logs generated by the control plane
- deployment events
- audit events
- queue payloads
- analytics
- error-tracking breadcrumbs
- structured request logs
- traces

### Redaction layer

The platform should implement defensive redaction at logging boundaries.

Potential techniques:

- known-secret-value redaction in worker process
- key-name based redaction
- structured logger serializers that omit sensitive fields

Redaction is defense in depth, not permission to casually log secrets.

## Error handling

Never include a plaintext secret inside an error message.

Bad:

```text
Connection failed using postgres://user:password@host
```

Good:

```text
Database connection failed for configured DATABASE_URL.
```

Diagnostic references may point to restricted internal records without exposing the value.

## Queue policy

Queue payloads contain IDs only.

Good:

```text
{ deployment_id: "..." }
```

Bad:

```text
{
  deployment_id: "...",
  env: {
    OPENAI_API_KEY: "sk-..."
  }
}
```

This reduces secret proliferation across infrastructure.

## Secret rotation

V1 should support replacement/rotation without exposing old values.

Conceptual flow:

```text
create new encrypted version
  -> mark new version current
  -> update binding
  -> future deployments use new version
  -> optional redeploy existing live app
  -> retire old version according to policy
```

A secret update should not mutate historical deployment plans.

## Versioning

Two acceptable V1 approaches:

### Option A - immutable secret versions

Each rotation creates a new secret_version row.

### Option B - secret row with versioned encrypted payload metadata

Simpler initially but must still preserve enough metadata to identify which version a deployment intended.

The final technology decision can choose the simpler safe implementation.

## Secret deletion

Deletion must consider active bindings.

Do not immediately destroy a secret still required by a live application without explicit workflow.

Possible lifecycle:

```text
ACTIVE
PENDING_DELETION
DELETED
```

Deletion workflow:

1. verify authorization
2. identify active bindings
3. require explicit confirmation if live app depends on it
4. remove provider runtime binding when requested
5. destroy encrypted material/reference
6. retain minimal non-sensitive audit metadata
7. mark deleted

## Application deletion

When an application is deleted:

- revoke/remove runtime secret bindings
- delete platform-managed application secrets according to retention policy
- revoke managed database credentials where possible
- preserve only non-sensitive audit history

## Workspace deletion

Workspace deletion requires a separate final cleanup process.

No cross-workspace ciphertext or references may remain incorrectly attached.

## Secret size limits

V1 should enforce bounded secret sizes.

This protects:

- database storage
- provider environment limits
- API abuse
- accidental large-file pastes

Exact byte limits should be chosen based on provider constraints during technology selection.

## Secret name validation

Environment variable keys should follow a conservative pattern.

Example:

```text
^[A-Z_][A-Z0-9_]*$
```

If V1 supports lowercase names later, do so intentionally.

Reserved platform keys should be blocked from user overwrite.

Examples conceptually:

```text
SSC_INTERNAL_*
PLATFORM_INTERNAL_*
```

Exact prefix to be chosen later.

## Provider environment injection

The runtime adapter receives a typed secret binding structure.

Conceptually:

```text
EnvironmentBinding {
  key
  sensitive = true
  value_handle
}
```

The adapter resolves plaintext at the latest possible moment.

Do not serialize provider environment requests into persistent logs.

## Secret exposure to build vs runtime

Some providers distinguish build-time and runtime variables.

V1 should default to the narrowest scope required.

If a secret is needed only at runtime, do not expose it to build steps unnecessarily.

If provider limitations prevent this distinction, document that explicitly as part of provider capability.

## Health verifier isolation

Health checks must not receive customer secrets unless the health-check protocol explicitly requires them.

V1 default health checks should be unauthenticated reachability checks against the deployed URL.

## Internal admin access

V1 should avoid any feature that allows ordinary platform administrators to casually reveal customer secret plaintext.

If emergency access is ever introduced later, it must require:

- explicit privileged role
- reason capture
- audit event
- potentially dual control

No such plaintext reveal feature is required for V1.

## Backups

If the control-plane database is backed up, encrypted secret ciphertext may be included.

The encryption master key must remain separate from database backup material.

A stolen database backup alone should not reveal plaintext secrets.

## Key rotation

The platform must be able to rotate its encryption key/version over time.

This does not require re-encrypting every secret synchronously.

Possible approach:

- new writes use current key version
- old values are rewrapped/re-encrypted lazily or by controlled migration
- key_version stored with secret material

## Testing requirements

Before external alpha, secrets handling should include tests for:

- encrypt/decrypt round trip
- wrong-workspace/context decryption rejection where supported
- API never returns plaintext after creation
- worker receives only required secrets
- queue payload contains no secret value
- logs/events contain no secret value
- rotation preserves new/current version
- deleted secret cannot be retrieved
- one tenant cannot reference another tenant's secret
- provider injection uses correct application binding

## Security invariant

A customer runtime must never receive:

- control-plane database credentials
- queue credentials
- runtime provider admin credentials
- database provisioning credentials
- GitHub App private credentials
- another application's secrets
- another workspace's secrets

Any violation is a critical security incident.

## V1 architecture summary

```text
User
  -> HTTPS API
  -> immediate encryption
  -> encrypted secret store/database record

Deployment worker
  -> load deployment plan
  -> resolve required bindings
  -> narrowly decrypt
  -> inject into target runtime
  -> discard plaintext

Customer runtime
  -> receives only application-specific environment secrets
```

## Quality gate

Before this architecture is considered implemented, confirm:

1. secret plaintext is encrypted before persistence
2. master key is separate from control-plane database
3. normal API reads cannot reveal plaintext
4. queue payloads contain identifiers only
5. logs/events/audits never contain plaintext
6. worker decryption is narrowly scoped
7. tenant ownership is checked before decrypt/use
8. provider credentials are never passed to customer runtimes
9. rotation works without exposing old values
10. deletion removes secret material safely
11. backups alone cannot reveal plaintext
12. encryption key rotation is possible

## Decision

Small Software Cloud V1 will treat customer secrets as a distinct high-sensitivity data class.

Secrets will be encrypted using managed cryptographic primitives, stored separately from ordinary configuration semantics, exposed only through narrow worker execution paths, and never returned through normal user-facing APIs after creation.

The next Node 02 document should define the GitHub integration specification: installation permissions, repository access, immutable revision resolution, webhook validation, event handling, and source retrieval boundaries.
