# Spike D - Durable Background Execution Results

## Status

**PASS**

## Purpose

Spike D validated that deployment execution can leave the initiating local process, run durably in Trigger.dev, deliberately fail after creating a provider runtime, retry automatically, recover canonical state from PostgreSQL, reconcile the same runtime resource, and complete successfully.

## Successful run

```text
deploymentKey: spike-d-1787718903528
triggerRunId: run_06g3omde43863vc9ou07139j01
```

Trigger.dev reported the root task as **Completed**.

Observed task output:

```text
result: SPIKE_D_TASK_PASS
attempts: 2
```

## Proven execution path

```text
Local process creates canonical QUEUED record in PostgreSQL
  -> local process triggers Trigger.dev
  -> Trigger.dev dequeues production task
  -> Attempt 1 begins
  -> Vercel runtime is created/reconciled
  -> runtime project ID is persisted in PostgreSQL
  -> intentional failure is raised after runtime creation
  -> Trigger.dev schedules Retry #1
  -> Attempt 2 begins independently
  -> canonical deployment state is re-read from PostgreSQL
  -> same deterministic Vercel runtime is reconciled
  -> runtime ID is checked against persisted canonical state
  -> deployment is started
  -> provider deployment reaches ready state
  -> PostgreSQL canonical status becomes LIVE
  -> Trigger.dev task completes
```

## Retry evidence

Trigger.dev trace showed:

```text
Attempt 1      failed intentionally after runtime creation
Retry #1       delay
Attempt 2      completed successfully
```

The successful task output reported:

```text
attempts = 2
```

This is the intended Spike D acceptance condition.

## Durability finding

The initiating PowerShell process is not the deployment executor.

After the trigger request is accepted, Trigger.dev owns task execution while PostgreSQL owns canonical deployment state.

Therefore deployment progress is no longer dependent on a browser request or local shell remaining alive.

## Reconciliation finding

The forced failure occurs only after a Vercel runtime resource exists and its ID has been persisted.

On retry, the task calls deterministic runtime reconciliation again and verifies that the resolved provider resource matches the persisted `runtime_project_id`.

A different runtime resource would cause the task to fail rather than silently continue.

This validates the core architecture rule:

> Durable retries must reconcile provider state against canonical control-plane state before continuing.

## Trigger.dev environment discovery

During setup, early runs were queued into Trigger.dev Development because the local client was authenticated with a Development secret (`tr_dev_...`). Those runs remained queued waiting for a local development worker.

Production execution required the environment-specific Production SDK secret (`tr_prod_sk_...`).

The Production worker also required these environment variables to be configured in Trigger.dev Production:

```text
DATABASE_URL
VERCEL_TOKEN
VERCEL_TEAM_ID
```

After the Production secret and Production worker environment were correctly configured, the task dequeued and executed successfully.

This is an operational/configuration finding rather than an architecture failure, and should inform future environment setup documentation and automated validation.

## Timing evidence

The successful Trigger.dev trace showed approximately:

```text
Triggered -> dequeued       271 ms
Queue/dequeue -> started    ~1.9 s
Total task execution        ~42.3 s
Trace duration              ~44.3 s
```

Attempt 1 failed intentionally after roughly 2.8 seconds, followed by a short retry delay. Attempt 2 then completed the deployment in roughly 36 seconds.

These are baseline measurements only; no latency optimization has been attempted.

## Acceptance criteria

### Execution survives outside initiating process

PASS.

### Canonical deployment state resides in PostgreSQL

PASS for the spike.

### First attempt can fail after durable provider mutation

PASS.

### Retry occurs automatically

PASS.

### Retry reads persisted state

PASS.

### Retry reconciles the existing runtime rather than blindly creating another

PASS.

### Runtime identity is verified against canonical state

PASS.

### Deployment ultimately reaches LIVE after retry

PASS.

### Retry count is observable

PASS (`attempts = 2`).

## Important limitations

This spike does not yet prove every production recovery scenario. In particular:

- timeout-after-provider-success without receiving the provider response remains to be simulated;
- durable operation/event history should eventually be richer than the single spike state row;
- concurrent duplicate task execution requires explicit locking/idempotency tests;
- production cleanup/garbage collection needs its own durable workflow;
- secrets are still provider environment values rather than KMS-envelope-encrypted control-plane records.

Those limitations do not invalidate Spike D's stated objective.

## Node 03 checkpoint

```text
Spike A - Runtime-only gold path                 PASS
Spike B - Failure/idempotency/cleanup            PASS
Spike C - Managed PostgreSQL                     PASS
Spike D - Durable Trigger.dev execution          PASS
Spike E - AWS KMS secret handling                NEXT
Spike F - GitHub App integration                 PENDING
```

## Decision

Spike D is accepted as passed for its stated scope.

The architecture spike has now proven the fundamental deployment control loop across GitHub source, managed runtime, managed PostgreSQL, persisted canonical state, provider reconciliation, and durable asynchronous retry.

Proceed to Spike E - AWS KMS secret handling.
