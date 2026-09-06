# Node 16 Reliability Evidence

Status: PASS. Existing Node 04.16-04.21 reliability/idempotency work proves the core recovery model, and the final read-only live orphan inventory scan found no actionable recoverable, orphan, or ambiguous SSC-owned Vercel resources.

Scope: SSC V1 deployment reliability only. No provider resources, databases, Trigger workers, workloads, or customer state were mutated for this packet.

## Gate 12 Reliability Requirements

| Requirement | Status | Evidence | Evidence Type | Smallest Remaining V1 Proof |
| --- | --- | --- | --- | --- |
| Repeatable deployments | ALREADY_PROVEN | `create-app-deployment.mjs` deduplicates by app plus commit SHA; `create-redeployment.ts` creates immutable child deployments from current GitHub head and refuses a second active redeploy; real DealUp and Vantage deployments reached `LIVE`. | Code, real-provider history, unit tests | None for current operator path |
| Failed operations recover safely | ALREADY_PROVEN | `deployment-recovery-rules.test.mjs` covers lost provider create response, provider build attachment, runtime reconciliation, health exhaustion, public verification replay, and terminal no-op behavior. | Fault-injection/unit tests | None for covered V1 deployment path |
| Provider failures do not corrupt control-plane state | ALREADY_PROVEN | `execute-build.ts` records provider operation intent before Vercel create; provider quota/rate/auth errors are persisted as error codes/events; `reconcile-build.ts` uses transactions for build success/failure/source mismatch; `health-check.ts` fails exhausted health checks transactionally. | Code and unit tests | None for known V1 provider failures |
| Retries are idempotent | ALREADY_PROVEN | Trigger retry settings are bounded; replay guards exist in analyze/build/runtime/public access/delete paths; provider operation ledger has unique `idempotency_key` and unique `(deployment_id, operation_type)`. | Code and unit tests | None for current path |
| State-machine integrity tested | ALREADY_PROVEN | `deployment-state.mjs` defines allowed transitions; `deployment-state.test.mjs` rejects illegal backward transitions and confirms retry/deletion paths. | Unit tests | None for current path |
| Terminal replay is safe | ALREADY_PROVEN | Orchestrator returns terminal no-op for `LIVE`, `FAILED`, `DELETED`; `reconcile-build.ts` and `configure-public-access.ts` also return terminal no-ops; tests cover public verification and terminal statuses. | Code and unit tests | None |
| Orphan/provider resource reconciliation works | ALREADY_PROVEN | `orphan-resource-classification.test.mjs` proves `KNOWN`, `RECOVERABLE`, `ORPHAN`, `AMBIGUOUS`, and `FOREIGN_IGNORE`; `detect-orphan-resources.ts` is read-only and never deletes/mutates; final live scan found `KNOWN=6`, `RECOVERABLE=0`, `ORPHAN=0`, `AMBIGUOUS=0`, `FOREIGN_IGNORE=1`, `ACTIONABLE=0`. | Unit tests, architecture, live provider inventory | None for current V1 path |
| Repeated user actions do not create duplicate infrastructure | ALREADY_PROVEN | App deployment creation deduplicates same app/source SHA; runtime has unique `app_id` and `reconciliation_key`; build creation uses provider operation ledger and SSC metadata lookup; deletion uses `app_deletions` unique app/deletion key. | Code and unit tests | None for current trusted operator path |

## Real Deployment Evidence

Existing real workloads inspected for reliability evidence:

| Workload | Deployment ID | Reliability Meaning |
| --- | --- | --- |
| DealUp | `fc494742-a56c-4050-8df0-0a667f32efa7` | Representative real deployment through SSC that reached `LIVE`; also restored and functionally verified in Node 18 |
| Vantage | `e1f03cb5-85e6-4261-aeed-a32f5f18e4ae` | Complex workload technically reached `LIVE`; timing history contains gaps and is not performance-representative |
| Recovery Test LIVE | `38a1dbc8-e200-45ae-9b42-a589ceb914dc` | Disposable recovery-path workload proving idempotency/recovery behavior |

Current evidence already proves:

- same app can redeploy through immutable child deployments (`create-redeployment.ts`)
- same immutable app/source SHA deployment is deduplicated (`create-app-deployment.mjs`)
- runtime reconciliation prevents duplicate runtime projects (`provision-runtime.ts`, `app_runtimes.app_id UNIQUE`, `reconciliation_key UNIQUE`)
- provider operation ledger prevents duplicate provider deployment after lost create response (`deployment_provider_operations.idempotency_key UNIQUE`, `vercel-deployment-recovery.mjs`)

## Fault-Injection / Provider Failure Evidence

| Scenario | Persisted State | Recovery Behavior | Duplicate Resource Risk | Final Diagnostic | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Provider deployment create ambiguity | Operation marked `AMBIGUOUS` | Explicit recovery error; no provider deployment is created | Controlled by refusing to choose | Actionable recovery failure | `deployment-recovery-rules.test.mjs`, `execute-build.ts` | PASS |
| Provider create succeeded but response lost | Operation is `CREATE_REQUESTED`; provider has SSC metadata | Replay searches provider deployments before create and returns pending/attach | Does not create a second deployment | Recovery pending or attached | `vercel-deployment-recovery.mjs`, tests | PASS |
| Build attachment/recovery | `deployment_builds` recreated/updated; operation marked `OBSERVED` | Existing provider deployment attached locally | Unique build/provider constraints | `BUILD_RECOVERY_ATTACHED` event | `execute-build.ts`, tests | PASS |
| Source mismatch | Build status `SOURCE_MISMATCH`; deployment `FAILED` | Non-retryable failure explaining immutable source mismatch | No duplicate create | `BUILD_SOURCE_MISMATCH` | `reconcile-build.ts`, diagnostics tests | PASS |
| Build timeout | Build marked `POLICY_TIMEOUT`; deployment `FAILED`; provider cancellation containment is recorded when an attached Vercel deployment exists | Orchestrator stops and returns timeout without claiming remote execution stopped unless cancellation/already-terminal evidence exists | No provider duplicate | `BUILD_TIMEOUT`, provider cancel events | `orchestrate-deployment.ts`, cancellation tests, diagnostics tests | PASS |
| Provider quota/rate/auth failure | Deployment error code set; operation `FAILED`; event recorded | Quota/auth block is explicit; rate limit retryable later | No build row created blindly | `VERCEL_DAILY_DEPLOYMENT_QUOTA`, `VERCEL_RATE_LIMIT`, or `VERCEL_AUTH` | `execute-build.ts`, diagnostics tests | PASS |
| Health exhaustion | Health attempts preserved; deployment `FAILED` transactionally | Orchestrator stops when terminal | No provider mutation | `HEALTH_CHECK_FAILED` | `health-check.ts`, tests | PASS |
| Public access blocked | Deployment remains `HEALTH_CHECKING`; event recorded | Replay re-verifies until fixed or terminal | No provider mutation | `PUBLIC_ACCESS_BLOCKED` | `configure-public-access.ts`, diagnostics tests | PASS |

## State-Machine Proof

`control-plane/src/deployment-state.mjs` defines the V1 lifecycle:

`DRAFT -> READY -> QUEUED -> ANALYZING -> PROVISIONING -> BUILDING -> DEPLOYING -> HEALTH_CHECKING -> LIVE`

It also permits bounded failure/deletion paths:

- `QUEUED`, `ANALYZING`, `PROVISIONING`, `BUILDING`, `DEPLOYING`, `HEALTH_CHECKING` may move to `FAILED`
- `FAILED` may be retried by moving to `QUEUED`
- active or terminal non-deleted states may move to `DELETING`
- `DELETING` may move to `DELETED` or `FAILED`
- `DELETED` has no outgoing transition

Tests prove:

- normal path is legal
- database provisioning can be used or skipped
- failed deployment may be requeued
- illegal backward transition is rejected
- `LIVE` and `DELETED` are terminal successful lifecycle states

Operational workers additionally protect terminal replay:

- `orchestrate-deployment.ts` returns terminal no-op for `LIVE`, `FAILED`, and `DELETED`
- `reconcile-build.ts` returns terminal no-op for terminal deployments
- `configure-public-access.ts` returns terminal no-op or live replay no-op
- `abandon-deployment.ts` returns terminal no-op for `LIVE`, `FAILED`, and `DELETED`

## Duplicate Action Safety Matrix

| Action | Classification | Evidence | Notes |
| --- | --- | --- | --- |
| create app deployment | DEDUPLICATED_BY_KEY | `create-app-deployment.mjs` locks repo/app and reuses existing deployment for same `app_id` and `source_commit_sha` | Same immutable source cannot create duplicate deployment row |
| queue deployment | IDEMPOTENT for `READY`/`QUEUED`/`ANALYZING` | `queue-deployment.mjs` commits `READY -> QUEUED`; rerun preserves `QUEUED` and resubmits Trigger | Split after Trigger submit is recoverable by rerun |
| orchestrate | TERMINAL_NOOP and replay-safe phase routing | terminal guard plus current-state dispatch | No generic workflow framework added |
| provision runtime | DEDUPLICATED_BY_KEY | `app_runtimes.app_id UNIQUE`, deterministic project name, remote runtime reconciliation | Existing remote project without local runtime is reconciled |
| apply runtime env | IDEMPOTENT | Vercel env `upsert=true`; `deployment_secret_applications` has `ON CONFLICT` update | Decrypts only same-app production bindings |
| execute build | DEDUPLICATED_BY_KEY | Provider operation ledger, SSC metadata search, unique build/provider ids | Lost create response no longer creates duplicate provider deployment |
| reconcile build | IDEMPOTENT | Provider status read; transactional state/event updates only from `BUILDING` | Terminal deployments no-op |
| redeploy | DEDUPLICATED_BY_KEY | `create-redeployment.ts` locks app and returns active deployment if one exists | Creates new immutable child only when no active deployment exists |
| delete | IDEMPOTENT | `app_deletions.app_id UNIQUE`; deletion key check; Vercel 204/404/410 treated success | Destructive by design; completed replay no-op |
| abandon | TERMINAL_NOOP | `abandon-deployment.ts` refuses terminal movement and records active abandonment transactionally | Does not delete provider resources |

No `NOT_SAFE` external-alpha path was found in the current trusted operator deployment path.

## Orphan / Inventory Proof

Implementation evidence:

- `detect-orphan-resources.ts` enumerates SSC-managed Vercel runtimes, fetches provider deployments, classifies SSC-owned metadata only, and returns safe counts/actionable items.
- It returns `destructiveOperationExecuted: false`, `providerResourcesMutated: false`, `providerResponseBodiesReturned: false`, `tokensPrinted: false`, and `secretsPrinted: false`.
- `orphan-resource-classification.test.mjs` proves known, recoverable, orphan, ambiguous, and foreign/ignore cases.
- Provider resources without SSC ownership metadata are never classified as SSC orphans.
- Terminal historical deployments with legitimate provider history are not falsely labelled orphan solely because they are terminal.

Final live scan result:

```text
result = NODE_04_19_ORPHAN_RESOURCE_DETECTION_COMPLETE
provider = vercel
runtimeCount = 3
providerProjectCount = 3
providerDeploymentCount = 7
KNOWN = 6
RECOVERABLE = 0
ORPHAN = 0
AMBIGUOUS = 0
FOREIGN_IGNORE = 1
ACTIONABLE = 0
```

Safety fields from the live scan:

- `destructiveOperationExecuted = false`
- `providerResourcesMutated = false`
- `providerResponseBodiesReturned = false`
- `tokensPrinted = false`
- `secretsPrinted = false`

## Control-Plane State Integrity

The current implementation prevents the requested unrecoverable states as follows:

| Bad State | Control |
| --- | --- |
| Provider resource created but completely untraceable | `execute-build.ts` writes provider operation intent before Vercel create and stamps provider metadata with deployment id/source SHA |
| Provider deployment attached to wrong source identity | `reconcile-build.ts` compares provider observed SHA with `deployment_builds.source_commit_sha`; source mismatch fails deployment |
| Failed operation silently marked LIVE | `LIVE` only follows health pass plus anonymous public access verification; provider build READY alone is insufficient |
| Terminal deployment overwritten by retry | Orchestrator, reconcile-build, public access, and abandon workers return terminal no-op |

Remaining known boundary: if the control-plane database is restored to an older point while provider resources remain, operators must run diagnostics/timeline/inventory/orphan detection read-only before any mutation. This is documented by Node 18 recovery evidence.

## Operator Reliability Runbook

Read-only inspection:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node .\scripts\list-app-inventory.mjs
node .\scripts\run-deployment-diagnostic.mjs <deployment-id>
node .\scripts\run-deployment-timeline.mjs <deployment-id>
node .\scripts\run-detect-orphan-resources.mjs
```

Safe recovery/replay actions:

```powershell
node .\scripts\run-orchestrator.mjs <deployment-id>
node .\scripts\run-provision-runtime.mjs <deployment-id>
node .\scripts\run-execute-build.mjs <deployment-id>
node .\scripts\run-public-access.mjs <deployment-id>
```

Explicit operator decisions:

```powershell
# Abandon a stuck active deployment without deleting provider resources.
trigger task: ssc-control-plane-abandon-deployment { deploymentId, reason }

# Delete an app and owned runtime resources. This is destructive and requires app/workspace/deletion key.
node .\scripts\run-delete-app.mjs
```

Recovery order after suspected interruption:

1. Inspect deployment diagnostic and timeline.
2. Check app inventory and provider operation ledger.
3. Run orphan detection read-only if provider/database state may diverge.
4. Rerun the narrowest existing reconciliation worker that matches the current state.
5. If the deployment is superseded or unrecoverable, explicitly abandon it.
6. Use delete only for intentional app teardown.

## Reliability Test Matrix

| Scenario | Expected State | Provider Mutation Expected | Replay Safe | Recovery Path | Evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| normal deployment | `LIVE` after public verification | yes, create/update runtime/env/deployment | yes | orchestrator state routing | real DealUp/Vantage; deployment tests | PASS |
| repeated create | same deployment for same app/source SHA | no duplicate | yes | app/source dedupe | `create-app-deployment.mjs` | PASS |
| repeated queue | `QUEUED`/`ANALYZING` preserved | Trigger submit may repeat | yes | rerun queue/orchestrator | `queue-deployment.mjs` | PASS |
| interrupted build create | provider deployment found or pending | no duplicate create | yes | provider metadata search and ledger | Node 04.18 tests | PASS |
| build failure | deployment `FAILED` | no new provider resource | yes | diagnostic/build logs | diagnostics/reconcile tests | PASS |
| build timeout | deployment `FAILED` with `BUILD_TIMEOUT`; remote containment attempted for attached provider deployment | no new provider resource; cancellation event evidence | yes | orchestrator timeout path | cancellation and diagnostics tests | PASS |
| health exhaustion | deployment `FAILED` with `HEALTH_CHECK_FAILED` | workload GET only | yes | health retry/exhaustion path | Node 04.18 tests | PASS |
| public access blocked | remains `HEALTH_CHECKING` and actionable | workload GET only | yes | rerun public verification after external fix | diagnostics tests | PASS |
| terminal replay | terminal no-op | no | yes | no-op | recovery-rule tests | PASS |
| deletion replay | completed no-op; missing provider project accepted | delete may repeat safely | yes | `app_deletions` ledger | delete-app code | PASS |
| orphan detection | safe counts/actionable classes | no | yes | read-only detector; manual repair later | classification tests; final live scan actionable count is `0` | PASS |

## Residual Risks

- Current live orphan inventory has no actionable recoverable, orphan, or ambiguous SSC-owned Vercel resources; future recovery drills should still run read-only inventory before any provider repair/delete mutation.
- Runtime logs remain provider-limited where feasible; build logs, diagnostics, health checks, timeline, and provider ids are available.
- Public/customer entrypoints are not implemented; current scripts/tasks remain trusted operator tools and must not be exposed directly.
- No generic rollback system exists; V1 recovery is replay/reconcile/abandon/delete.
- DB-level composite tenant constraints remain a future hardening item from Node 15, not a Node 16 reliability blocker for the current operator path.

## Node 16 Status

`REPEATABLE_DEPLOYMENTS = PASS`

`FAILED_OPERATION_RECOVERY = PASS`

`PROVIDER_FAILURE_STATE_INTEGRITY = PASS`

`RETRY_IDEMPOTENCY = PASS`

`STATE_MACHINE_INTEGRITY = PASS`

`TERMINAL_REPLAY_SAFETY = PASS`

`ORPHAN_RECONCILIATION = PASS`

`FIX_BEFORE_ALPHA_FINDINGS = 0`

`NEW_CODE_CHANGES_REQUIRED = false`

`NODE_16_RELIABILITY_EVIDENCE = PASS`

`NODE_16_COMPLETE = true`

`GATE_12_COMPLETE = false`
