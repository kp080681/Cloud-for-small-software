# Node 17 Performance Evidence

Status: evidence tooling and architecture audit complete; real deployment timing extraction is pending a shell with `DATABASE_URL`. Node 17 is not complete until the analyzer is run against the control-plane database and the measured table is recorded.

Scope: SSC V1 control-plane performance only. This is not a public SLA. Do not mutate deployments, provider resources, or production data for this evidence.

## Evidence Command

Run from the control-plane directory with read access to the control-plane PostgreSQL database:

```powershell
cd "C:\Users\Dealup Admin\OneDrive - Dealup Strategies Private Limited\Documents\ChatGPT\Cloud for small Software\control-plane"
node .\scripts\analyze-deployment-performance.mjs
```

The script is read-only. It:

- connects to `DATABASE_URL`
- loads diagnostic context and full timeline history for the requested deployments
- reuses `normalizeDeploymentDiagnostic` and `normalizeDeploymentTimeline`
- computes stage timing through `normalizeDeploymentPerformance`
- measures a small number of DB-backed read calls
- performs only a few anonymous GET observations against `live_url` for LIVE deployments
- does not call Vercel provider APIs
- does not call Trigger tasks
- does not execute database writes

## Deployment Timing Inputs

Preferred existing deployments:

| Workload | Deployment ID | Evidence Status |
| --- | --- | --- |
| DealUp | `fc494742-a56c-4050-8df0-0a667f32efa7` | Pending analyzer run |
| Vantage | `e1f03cb5-85e6-4261-aeed-a32f5f18e4ae` | Pending analyzer run |
| Recovery Test LIVE | `38a1dbc8-e200-45ae-9b42-a589ceb914dc` | Pending analyzer run |

Expected analyzer output per deployment:

```json
{
  "deploymentId": "...",
  "appSlug": "...",
  "totalDurationMs": null,
  "queueLatencyMs": null,
  "analysisDurationMs": null,
  "provisioningDurationMs": null,
  "buildDurationMs": null,
  "healthDurationMs": null,
  "publicAccessDurationMs": null,
  "providerDominatedDurationMs": null,
  "controlPlaneObservedDurationMs": null
}
```

If a historical stage is ambiguous or incomplete, the normalizer returns `null` instead of inventing timing.

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

## Current Measurement Status

This Codex session could not extract real persisted deployment timing because `DATABASE_URL` was not loaded in the shell.

| Metric | Current Value |
| --- | --- |
| `DEALUP_TOTAL_DEPLOY_DURATION_MS` | `NOT_MEASURED` |
| `VANTAGE_TOTAL_DEPLOY_DURATION_MS` | `NOT_MEASURED` |
| `RECOVERY_TEST_TOTAL_DEPLOY_DURATION_MS` | `NOT_MEASURED` |
| `CONTROL_PLANE_READ_P50_MS` | `NOT_MEASURED` |
| `CONTROL_PLANE_READ_MAX_MS` | `NOT_MEASURED` |

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

Measured public latency samples are pending the analyzer run. These samples are provider/workload/network observations, not SSC-added latency and not public SLA data.

## Bottleneck Audit

| Area | Finding | Classification | Evidence / Rationale |
| --- | --- | --- | --- |
| Provider build polling | 15 second polling loop while provider build is active | ALREADY_ACCEPTABLE | Durable Trigger worker loop; provider build dominates; bounded by policy |
| Health retry polling | 10 second retry loop | ALREADY_ACCEPTABLE | Bounded by max health attempts; avoids request-path blocking |
| Env detection source blobs | Blob fetches are sequential | MEASURE_LATER | Bounded by 15.4 file/byte limits; parallelizing may hit GitHub limits and is not needed before evidence |
| Runtime env application | Secret bindings are applied sequentially to Vercel env API | MEASURE_LATER | V1 env counts are policy-bounded; avoids rate-limit bursts |
| Build log ingestion | Up to 200 provider events ingested | ALREADY_ACCEPTABLE | `MAX_EVENTS = 200`, messages truncated and redacted |
| Orphan detection | Lists up to 100 deployments per project and fetches detail per candidate | MEASURE_LATER | Read-only operator task; not in deployment critical path |
| Diagnostic/timeline reads | Multiple DB reads per diagnostic context | MEASURE_LATER | Expected small data volume; analyzer will measure p50/max |
| Public API rate/concurrency | No public customer API layer exists yet | HARDEN_BEFORE_BETA | Not a current performance blocker; rate limits belong with future external entrypoints |
| Runtime proxy | No SSC runtime proxy exists | ALREADY_ACCEPTABLE | Architecture keeps requests direct to Vercel |

`FIX_BEFORE_ALPHA_FINDINGS = 0` based on code inspection. This should be revisited after real analyzer numbers are recorded.

## Resource / Cost Notes

- Node 04.18 build recovery prevents duplicate provider deployments after lost create responses.
- Runtime provisioning reconciles deterministic Vercel projects instead of recreating them.
- Vercel Git auto-deploy is disabled for SSC-managed projects, preventing provider-side deployment duplication.
- Build log ingestion is bounded to reduce storage/API cost.
- Orphan detection is read-only and should remain operator-initiated until scheduling is justified.
- Provider polling intervals are coarse enough for V1 and avoid aggressive API usage.

Do not add cost accounting or cache layers before evidence shows a real alpha bottleneck.

## Internal V1 Targets

Internal engineering targets only, not customer commitments:

- Control-plane diagnostic/timeline/simple lookup reads should be sub-second under current small-load data.
- Queue acknowledgement should complete quickly after the `READY -> QUEUED` database transition and Trigger submission.
- Provider build time is excluded from SSC responsiveness expectations.
- Health and public verification should stay bounded by configured health attempts and request timeouts.
- SSC should add no runtime request hop after deployment.
- Any stage timing that cannot be proven from durable timestamps should remain `null`.

## Limitations

- Real timing extraction was not run in this shell because `DATABASE_URL` was missing.
- Public latency samples require live workload URLs from the control-plane database.
- Measurements will reflect current small-load, founder-operated conditions only.
- Provider build/runtime performance is mostly provider and application dependent.
- No load testing was performed or recommended for V1 at this stage.

## Node 17 Status

`NODE_17_PERFORMANCE_EVIDENCE = PARTIAL`

`NODE_17_COMPLETE = false`

`GATE_12_COMPLETE = false`
