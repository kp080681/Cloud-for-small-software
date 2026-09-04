# Node 17 Performance Evidence

Status: read-path analyzer defect found and fixed; real pre-fix database measurements are recorded below. Node 17 remains open until the corrected analyzer is rerun from an operator shell with `DATABASE_URL` loaded and post-fix read timings are recorded.

Scope: SSC V1 control-plane performance only. These numbers are internal engineering observations, not public SLA commitments. The evidence command is read-only and must not mutate deployments, provider resources, production data, Trigger runs, or provider state.

## Evidence Command

Run from the control-plane directory with read access to the control-plane PostgreSQL database:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node .\scripts\analyze-deployment-performance.mjs
```

The script is read-only. It:

- connects to `DATABASE_URL`
- measures connection setup separately from steady-state reads
- loads diagnostic context and full timeline history for the requested deployments
- reuses `normalizeDeploymentDiagnostic` and `normalizeDeploymentTimeline`
- computes stage timing through `normalizeDeploymentPerformance`
- reports query-count instrumentation for the representative DealUp deployment
- performs only a few anonymous GET observations against `live_url` for LIVE deployments
- does not call Vercel provider APIs
- does not call Trigger tasks
- does not execute database writes

## Real Pre-Fix Measurements

These results came from the real control-plane database before the read-path fix in this node.

| Metric | Value |
| --- | ---: |
| Connection setup | `2328 ms` |
| Steady-state combined p50 | `2664 ms` |
| Steady-state combined max | `2824 ms` |
| SSC runtime proxy present | `false` |
| Async infrastructure operations | `true` |
| Provider calls executed | `false` |
| Trigger calls executed | `false` |
| Database writes executed | `false` |

| Workload | Simple Lookup | Diagnostic | Timeline |
| --- | ---: | ---: | ---: |
| DealUp | `280 ms` | `2824 ms` | `2787 ms` |
| Vantage | `266 ms` | `2807 ms` | `2561 ms` |
| Recovery Test LIVE | `306 ms` | `2664 ms` | `2805 ms` |

Runtime HTTP samples returned HTTP `200` for all three deployments. Individual runtime latency durations were not included in this measurement handoff, so only the successful status evidence is recorded here.

## Query Count Investigation

`loadDeploymentDiagnosticContext` performs one base deployment/app/policy lookup, then eight independent read-only context queries:

1. deployment/app/policy
2. deployment events
3. deployment build
4. latest health check
5. health check count
6. required env/binding status
7. env detection snapshot
8. build log count
9. provider operation

Before this fix, the diagnostic and timeline paths were measured through a single `pg.Client`. After the Node 17 null-timing correction, those nine reads were awaited sequentially to avoid the pg warning:

`Calling client.query() when the client is already executing a query is deprecated`

That made each diagnostic/timeline operation roughly nine remote database round trips. The direct lookup path is one round trip and measured roughly `0.27-0.31 s`, which matches the observed `2.56-2.82 s` diagnostic/timeline timings for nine sequential reads.

Classification:

| Cause | Finding |
| --- | --- |
| Network latency multiplied by sequential queries | Primary root cause |
| Expensive SQL | Not proven; direct table reads are small and simple |
| N+1 query pattern | Not an unbounded N+1; fixed count of nine context reads |
| Unnecessary data retrieval | Partial: analyzer loads diagnostic context twice when measuring diagnostic and timeline as separate operations, but each operation needs context independently |
| Client lifecycle/connection issue | Connection setup is high at `2328 ms`, but it is now reported separately and is not mixed into steady-state read timing |

## Read-Path Fix

The fix is deliberately small:

- `loadDeploymentDiagnosticContext` now supports safe independent-query execution.
- A single `pg.Client` caller remains sequential, preserving warning-free behavior for transaction-like or single-connection use.
- A `pg.Pool` caller can execute the eight independent post-deployment reads concurrently on separate checked-out connections.
- The analyzer now uses a bounded `pg.Pool` with `max: 9` and performs a warm-up `SELECT 1` so connection setup is measured separately.
- The analyzer records DealUp diagnostic/timeline query instrumentation: SQL round-trip count and per-query durations.
- The analyzer now passes the raw diagnostic context to `normalizeDeploymentPerformance`; this fixes the prior `null` deployment ID, app slug, and timing fields.

This does not add caching, Redis, indexing, new infrastructure, state-machine changes, provider calls, or write behavior.

## Post-Fix Measurement Status

This Codex task still does not have `DATABASE_URL` available in process, user, machine, or repository `.env*` scope, so the corrected analyzer could not be rerun from this task after the pool fix. The required next operator measurement is:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node .\scripts\analyze-deployment-performance.mjs
```

Record the post-fix values here after that read-only run:

| Metric | Post-Fix Value |
| --- | --- |
| Connection setup | `PENDING_OPERATOR_RERUN` |
| DealUp simple lookup p50 | `PENDING_OPERATOR_RERUN` |
| DealUp diagnostic p50 | `PENDING_OPERATOR_RERUN` |
| DealUp timeline p50 | `PENDING_OPERATOR_RERUN` |

## Deployment Elapsed Histories

| Workload | Deployment ID | Total | Queue | Analysis | Provisioning | Build | Health | Public Access | Classification |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| DealUp | `fc494742-a56c-4050-8df0-0a667f32efa7` | `148041 ms` | `5064 ms` | `94947 ms` | `3416 ms` | `34553 ms` | `484 ms` | `1939 ms` | `REPRESENTATIVE` |
| Vantage | `e1f03cb5-85e6-4261-aeed-a32f5f18e4ae` | `257467267 ms` | `337181 ms` | `61236545 ms` | `1891593 ms` | `118154 ms` | `386 ms` | `1050120 ms` | `HISTORICAL_WITH_GAPS` |
| Recovery Test LIVE | `38a1dbc8-e200-45ae-9b42-a589ceb914dc` | `965854 ms` | `5707 ms` | `35666 ms` | `859977 ms` | `52971 ms` | `471 ms` | `1949 ms` | `TEST_RECOVERY_PATH` |

Interpretation:

- DealUp is the primary representative continuous deployment for V1 performance evidence unless later event inspection disproves that.
- Vantage contains very large elapsed gaps and must not be described as normal deployment performance. It is historical evidence that Vantage reached LIVE through SSC, not a representative timing sample.
- Recovery Test LIVE intentionally belongs to recovery/idempotency evidence. Its provisioning duration includes recovery-path behavior and is not representative of normal deployment performance.

Historical deployment events must remain immutable. Do not delete, compress, or rewrite events to make durations look cleaner.

## Timing Definitions

| Metric | Definition |
| --- | --- |
| `totalDurationMs` | queued or created time to terminal/public completion time |
| `queueLatencyMs` | queued time to analysis start |
| `analysisDurationMs` | analysis start to env verification / transition to provisioning |
| `provisioningDurationMs` | env verification / provisioning start to runtime provisioned/reconciled |
| `buildDurationMs` | provider build requested to build success/failure/timeout/source mismatch |
| `healthDurationMs` | health check start to health pass/failure |
| `publicAccessDurationMs` | health pass to public access verified/blocked |
| `providerDominatedDurationMs` | provisioning plus provider build duration when known |
| `controlPlaneObservedDurationMs` | queue, analysis, health, and public verification duration when known |

If a historical stage is ambiguous or incomplete, the normalizer returns `null` instead of inventing timing.

## Async Architecture Evidence

SSC's slow infrastructure work is asynchronous relative to the initial queueing step:

- `queue-deployment.mjs` commits `READY -> QUEUED` and its audit event before submitting the Trigger task.
- `orchestrate-deployment.ts` delegates slow phases to Trigger workers through `tasks.triggerAndWait`.
- Provider build polling is inside the durable orchestrator loop, not a user-facing synchronous request path.
- Build polling is bounded by `max_build_minutes`.
- Health retry polling is bounded by `max_health_attempts`.
- Terminal replay guards prevent already LIVE/FAILED/DELETED deployments from looping.

`ASYNC_INFRA_OPERATIONS = true`.

## Runtime Latency / No Proxy Evidence

SSC does not proxy workload traffic after deployment:

- `execute-build.ts` creates a Vercel deployment for the immutable GitHub source.
- `configure-public-access.ts` verifies anonymous HTTPS access and stores the workload URL as `deployments.live_url`.
- Customer runtime traffic goes directly to the Vercel workload URL.
- Control-plane HTTP requests are limited to health/public verification and operator diagnostics; they are not in the runtime request path.

`SSC_RUNTIME_PROXY_PRESENT = false`.

## Bottleneck Audit

| Area | Finding | Classification | Evidence / Rationale |
| --- | --- | --- | --- |
| Diagnostic/timeline reads | Nine context SQL round trips; pre-fix sequential remote reads measured `~2.6-2.8 s` | FIX_APPLIED_MEASURE_NEXT | Pool-based independent reads added; post-fix operator measurement still required |
| Provider build polling | 15 second polling loop while provider build is active | ALREADY_ACCEPTABLE | Durable Trigger worker loop; provider build dominates; bounded by policy |
| Health retry polling | 10 second retry loop | ALREADY_ACCEPTABLE | Bounded by max health attempts; avoids request-path blocking |
| Env detection source blobs | Blob fetches are sequential | MEASURE_LATER | Bounded by 15.4 file/byte limits; parallelizing may hit GitHub limits and is not needed before evidence |
| Runtime env application | Secret bindings are applied sequentially to Vercel env API | MEASURE_LATER | V1 env counts are policy-bounded; avoids rate-limit bursts |
| Build log ingestion | Up to 200 provider events ingested | ALREADY_ACCEPTABLE | `MAX_EVENTS = 200`, messages truncated and redacted |
| Orphan detection | Lists up to 100 deployments per project and fetches detail per candidate | MEASURE_LATER | Read-only operator task; not in deployment critical path |
| Public API rate/concurrency | No public customer API layer exists yet | HARDEN_BEFORE_BETA | Not a current performance blocker; rate limits belong with future external entrypoints |
| Runtime proxy | No SSC runtime proxy exists | ALREADY_ACCEPTABLE | Architecture keeps requests direct to Vercel |

`FIX_BEFORE_ALPHA_FINDINGS = 0` based on current evidence. The only open Node 17 evidence item is post-fix measurement from a shell with `DATABASE_URL`.

## Limitations

- Post-fix DB measurements were not run in this Codex task because `DATABASE_URL` is unavailable.
- Public runtime latency durations were not included in the measurement handoff, only HTTP `200` outcomes.
- Measurements reflect current small-load, founder-operated conditions only.
- Provider build/runtime performance is mostly provider and application dependent.
- No load testing was performed or recommended for V1 at this stage.
- Vantage and Recovery Test elapsed histories contain non-representative gaps and must not be used as normal deployment performance samples.

## Node 17 Status

`NODE_17_PERFORMANCE_EVIDENCE = PARTIAL`

`NODE_17_COMPLETE = false`

`GATE_12_COMPLETE = false`
