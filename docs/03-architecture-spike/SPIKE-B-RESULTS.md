# Spike B - Failure, Idempotency, and Cleanup Results

## Status

**PASS**

## Purpose

Spike B validated controlled deployment failure, duplicate runtime reconciliation, secret-output discipline, and repeated cleanup safety.

## Test revision

```text
Repository: kp080681/Cloud-for-small-software
Branch: main
Commit: 50c810dad902fd1e76db6532975b51f649d9aaf7
```

## Result summary

The test intentionally created one runtime, repeated the same logical runtime creation, forced a build failure, verified the failed deployment was never treated as LIVE, and deleted the runtime twice.

Observed result:

```text
SPIKE_B_PASS
```

## Idempotent runtime creation

First logical create:

```text
created = true
reconciled = false
projectId = prj_pEPdfUHvKvptN9oOsfKv6OYDqzJd
```

Second logical create using the same deterministic project identity:

```text
sameProject = true
created = false
reconciled = true
projectId = prj_pEPdfUHvKvptN9oOsfKv6OYDqzJd
```

### Finding

The adapter can reconcile a repeated logical runtime-create request to the existing provider resource instead of creating a duplicate project.

This validates the core retry principle:

> Reconcile before repeating provider resource creation.

## Controlled build failure

The spike deliberately supplied an invalid build command:

```text
node -e "process.exit(73)"
```

Provider deployment:

```text
deploymentId = dpl_DPrp8T5Rt6DSVhb9kXNUttc2H8w2
terminalState = ERROR
correctlyRejected = true
markedLive = false
```

### Finding

Creation of a provider deployment object is not considered application success.

The runtime adapter waited for terminal provider state, observed `ERROR`, and the test explicitly confirmed the deployment was never marked LIVE.

This is consistent with the canonical architecture:

```text
provider resource created
  !=
platform deployment success
```

## Secret-output check

The Vercel automation protection bypass secret was used internally but was not included in the spike output.

Observed:

```text
protectionBypassPrinted = false
```

This is not yet a complete secrets-security test, but confirms the spike runner does not casually serialize this sensitive provider credential into normal result output.

## Cleanup idempotency

First deletion:

```text
deleted = true
alreadyAbsent = false
```

Second deletion of the same provider resource:

```text
deleted = true
alreadyAbsent = true
```

### Finding

Provider `404 / already absent` can safely reconcile to successful deletion when deletion is the platform's intended state.

Repeated cleanup therefore does not fail or create ambiguity.

## Acceptance criteria status

### Failed build never becomes LIVE

PASS.

### Current state remains explainable

PASS for the spike-level provider lifecycle. Provider deployment reached explicit terminal state `ERROR`.

Full persisted deployment event/state recovery remains for later Node 03 stages.

### Duplicate execution does not duplicate durable runtime resources

PASS for repeated runtime creation using deterministic provider identity/reconciliation.

### Uncertain provider write is reconciled before retry

PARTIALLY PROVEN.

Repeated create reconciliation is proven. A true network timeout-after-success simulation remains to be tested when durable provider-operation tracking is introduced.

### Retry behaviour is bounded

PASS for this spike runner: no uncontrolled retry loop was introduced.

Full Trigger.dev retry policy is deferred to Spike D.

### Cleanup leaves no unexplained resource

PASS for the test runtime.

Repeated deletion reconciled safely to already absent.

## Important limitation

Spike B does not yet prove crash-safe orchestration across process termination because canonical deployment state is not yet persisted in PostgreSQL and background execution is not yet running through Trigger.dev.

Those concerns remain explicitly assigned to later Node 03 spikes.

## Architecture conclusions

Spike B strengthens the V1 runtime-adapter contract with the following proven behaviours:

```text
ensureRuntime()
  -> return existing resource when logical create is repeated

deployment terminal ERROR
  -> never interpret as LIVE

deleteRuntime()
  -> treat already-absent resource as successful reconciliation
```

## Day checkpoint

At the end of this session:

```text
Spike A - Runtime-only gold path                 PASS
Spike B - Failure/idempotency/cleanup            PASS
Spike C - Managed PostgreSQL                     NEXT
Spike D - Durable Trigger.dev execution          PENDING
Spike E - AWS KMS secret handling                PENDING
Spike F - GitHub App integration                 PENDING
```

## Decision

Spike B is accepted as passed for its stated scope.

The next Node 03 task is Spike C - Managed PostgreSQL provisioning and binding.
