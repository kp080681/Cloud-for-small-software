# Spike E Results — KMS-backed Secret Management

**Date:** 2026-08-26  
**Result:** PASS

## Objective

Prove that Small Software Cloud can accept application secrets, persist them without plaintext storage, and make them available to a durable production worker only when required for execution.

This spike specifically tested envelope encryption using AWS KMS, PostgreSQL persistence, and Trigger.dev production execution.

## Architecture tested

```text
Application secret
      |
      v
AWS KMS GenerateDataKey
      |
      +--> plaintext AES-256 data key (memory only)
      |
      +--> encrypted data key
                |
                v
AES-256-GCM encrypt application secret
                |
                v
PostgreSQL persists
  - ciphertext
  - encrypted data key
  - IV
  - authentication tag
  - verification digest
  - workspace/app/secret metadata
                |
                v
Trigger.dev receives secret ID + scope only
                |
                v
Worker loads encrypted record
                |
                v
AWS KMS Decrypt encrypted data key
                |
                v
AES-256-GCM decrypt in worker memory
                |
                v
Verification succeeds
```

## Security properties demonstrated

### 1. Plaintext is not persisted

The generated application secret is encrypted before PostgreSQL persistence.

Observed local result reported:

```json
{
  "result": "SPIKE_E_QUEUED",
  "persistedPlaintext": false,
  "encryptedDataKeyStored": true,
  "ciphertextStored": true,
  "plaintextPrinted": false
}
```

The plaintext secret itself is deliberately excluded from output and logs.

### 2. Envelope encryption works

AWS KMS generates an AES-256 data key. The plaintext form is used only in process memory to perform AES-256-GCM encryption and is then zeroed where practical. Only the KMS-encrypted data key is persisted.

The KMS customer-managed key is referenced by `AWS_KMS_KEY_ID`.

### 3. Cryptographic tenant/application binding

The KMS encryption context and AES-GCM additional authenticated data bind the encrypted material to:

- workspace ID
- application ID
- secret ID
- Small Software Cloud Spike E namespace

The decrypt path also checks the expected workspace and application before attempting decryption.

This means an encrypted record cannot simply be moved into another application scope and treated as a valid secret.

### 4. Least-privilege AWS identity

A dedicated IAM user was created for the spike:

`small-software-cloud-kms`

It has no AWS console access and was granted only:

```text
kms:GenerateDataKey
kms:Decrypt
```

The IAM policy is restricted to the specific Small Software Cloud customer-managed KMS key rather than `Resource: *`.

No broad AWS administrator policy is used by the workload.

### 5. Production worker decryption works

The Spike E Trigger.dev task was deployed to the Production environment.

The worker successfully:

1. received the secret ID and application scope,
2. loaded the encrypted PostgreSQL record,
3. called AWS KMS,
4. recovered the data key,
5. decrypted the secret in memory,
6. verified the secret,
7. completed successfully.

Observed Trigger.dev result: **Completed**.

### 6. Credentials remain outside source control

The following values are supplied through environment configuration and are not committed to the repository:

```text
DATABASE_URL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
AWS_KMS_KEY_ID
TRIGGER_SECRET_KEY
```

AWS credentials used by the production worker are stored as Trigger.dev Production environment variables.

## Implementation

Spike implementation lives under:

```text
spikes/05-kms-secrets/
```

Key files:

```text
secret-store.mjs
run-spike-e.mjs
trigger/verify-secret.ts
trigger.config.ts
package.json
```

`secret-store.mjs` implements the envelope-encryption storage/decryption path.

## Problems encountered

### Incorrect KMS identifier configuration

`AWS_KMS_KEY_ID` was initially entered incorrectly in the production worker environment.

Resolution: use the full ARN of the customer-managed KMS key.

### AWS InvalidSignatureException

The first production worker KMS call returned `InvalidSignatureException`.

The local encryption path had already succeeded using the same IAM identity, isolating the issue to the credentials configured in Trigger.dev Production.

Resolution: replace the Trigger.dev `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values with the exact known-working credential pair and redeploy.

The subsequent Trigger.dev execution completed successfully.

## What this spike proves

Small Software Cloud can implement a control-plane secret store without keeping customer application secrets as plaintext database values.

It also demonstrates a viable path for runtime workers to retrieve secrets only when needed while keeping the persistent representation encrypted under an external KMS root of trust.

## What this spike does NOT yet prove

A PASS here does not mean the production security design is complete.

Before arbitrary external customer workloads are accepted, further work is required around:

- replacing long-lived IAM user access keys where practical with workload identity / short-lived credentials,
- credential rotation,
- KMS key rotation and lifecycle policy,
- secret update/versioning semantics,
- secret deletion guarantees,
- audit logging and access trails,
- authorization between control plane and worker,
- preventing customer workload access to control-plane credentials,
- workload/network isolation,
- incident recovery and credential revocation,
- security review of the complete deployment boundary.

## Decision

**SPIKE E PASS**

KMS-backed envelope encryption is suitable as the initial secret-management direction for Small Software Cloud.

The architecture can proceed without building a custom cryptographic key-management system.

## Architecture spike status

```text
Spike A  Runtime provisioning        PASS
Spike B  Reconciliation/failures     PASS
Spike C  PostgreSQL provisioning     PASS
Spike D  Durable execution           PASS
Spike E  KMS secret management       PASS
```

Five major infrastructure assumptions have now been tested against real provider APIs rather than remaining paper architecture.
