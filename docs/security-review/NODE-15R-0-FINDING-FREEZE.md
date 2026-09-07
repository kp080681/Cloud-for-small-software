# Node 15R.0 Finding Freeze

Status: documentation-only reproduction complete. This file freezes alpha-relevant security findings reproduced or falsified from the production control-plane code at `aa0512c38474806ffb51254edbe667d9d4539a90`.

Scope: repository evidence, static inspection, and isolated mock-level reasoning only. No production code was changed for this node. No provider configuration, provider resources, database rows, Trigger workers, workloads, or secrets were mutated.

Important source note: `docs/security-review/NODE-15R-PREALPHA-SECURITY-REMEDIATION-GRAPH.md` was requested as the current remediation graph, but it is not present in this checkout. The classifications below are therefore derived from actual production-path code and existing evidence packets.

Classification key:

- `CONFIRMED`: production-path code allows the claimed condition.
- `CONFIRMED_PROVIDER_DEPENDENT`: production-path code leaves the invariant dependent on provider behavior/settings not proven in this repository.
- `PARTIALLY_CONFIRMED`: part of the claim is true, but existing controls reduce or narrow the consequence.
- `NOT_REPRODUCED`: inspected behavior did not reproduce the claim.
- `REJECTED`: production-path code contradicts the claim.

## Frozen Findings

### P0-A - Cross-Tenant Vercel Project Adoption Caused By Duplicate App Slugs

Reviewer claim: two workspaces can each have an app with the same slug and both can adopt the same Vercel project because runtime project naming is based only on slug.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_4`

Remediation status: `RESOLVED_BY_15R_1`. Node 15R.1 replaces slug-only provider project identity with deterministic workspace/app-id-based project names, refuses remote project adoption unless the remote project name matches the expected SSC app identity, adds local provider project uniqueness, and verifies runtime identity before secret injection, build targeting, and provider deletion.

Exact files/functions:

- `control-plane/db/001_initial_schema.sql`: `apps` has `UNIQUE (workspace_id, slug)`, so duplicate slugs across workspaces are valid.
- `control-plane/trigger/provision-runtime.ts`: project name is `ssc-${deployment.slug}` with no workspace/app component.
- `control-plane/src/vercel-runtime-recovery.mjs`: any remote project returned by name is accepted as `reconcile-remote-project`.
- `control-plane/trigger/apply-runtime-env.ts`: env upsert targets `deployment.provider_project_id`.
- `control-plane/trigger/execute-build.ts`: build create uses `project: deployment.provider_project_id`.
- `control-plane/trigger/delete-app.ts`: delete uses frozen `app_deletions.provider_project_id`.

Reproduction method: isolated mock reasoning with Workspace A/App A slug `dashboard` and Workspace B/App B slug `dashboard`. Both resolve `PROJECT_NAME_A = ssc-dashboard` and `PROJECT_NAME_B = ssc-dashboard`. If Vercel `GET /v9/projects/ssc-dashboard` returns `PROVIDER_PROJECT_ID_A = prj_same`, both production paths can persist or use `PROVIDER_PROJECT_ID_B = prj_same`.

Observed result:

```text
PROJECT_NAME_A = ssc-dashboard
PROJECT_NAME_B = ssc-dashboard
PROVIDER_PROJECT_ID_A = prj_same
PROVIDER_PROJECT_ID_B = prj_same
REMOTE_IDENTITY_VALIDATION_PRESENT = false
CROSS_TENANT_PROJECT_ADOPTION = true
```

Concrete consequence: B can inject secrets into A's provider project, deploy B code to A's project, or delete A's provider project if B's local runtime row points at the adopted project.

Required next node: `15R.1 Provider Project Identity / Slug Collision`

Provider verification required? No for the code defect; yes to understand already-created project inventory.

Notes: this is the highest-priority remediation because it crosses tenant, secret, deployment, and deletion boundaries.

### P0-B - Slug-Only Mutating Operator Commands Can Select The Wrong Workspace/App

Reviewer claim: mutating operator scripts select by slug alone and can operate on the wrong workspace when slugs collide.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_2`

Exact files/functions:

- `control-plane/scripts/set-app-secret.mjs`: `WHERE slug=$1 AND deleted_at IS NULL LIMIT 1`
- `control-plane/scripts/import-env-file.mjs`: `WHERE lower(slug) = lower($1) LIMIT 1`
- `control-plane/scripts/run-delete-app.mjs`: `WHERE lower(slug)=lower($1) LIMIT 1`
- `control-plane/scripts/run-redeploy.mjs`: `WHERE lower(slug)=lower($1) AND deleted_at IS NULL LIMIT 1`
- `control-plane/scripts/run-apply-runtime-env.mjs`, `run-detect-env-requirements.mjs`, `run-prepare-build-input.mjs`, `run-orchestrator.mjs`, `run-provision-runtime.mjs`, `run-execute-build.mjs`, `run-public-access.mjs`, `run-resource-policy.mjs`, `run-verify-env-requirements.mjs`, `verify-build-input.mjs`, `verify-env-requirements.mjs`, `verify-runtime.mjs`, and `seed-vantage-env-requirements.mjs` use slug-only lookup for deployment/app selection.

Reproduction method: two-workspace same-slug mock. Because the queries do not include workspace identity or repository identity, PostgreSQL may return whichever matching row satisfies the plan/order. Downstream tasks receive the selected app/deployment id and then validate that same selected record, not the operator's intended workspace.

Observed result: founder intending Workspace B can select Workspace A if both have the same slug and the A row is returned by the slug-only query.

Concrete consequence: wrong app secret update/import, wrong app delete, wrong redeploy, wrong targeted worker rerun, or wrong verification command.

Resolution: Node `15R.2 Tenant-Safe Operator Targeting` adds a shared operator target resolver and rewires mutating operator scripts so slug lookup requires workspace identity, app-id targeting is workspace-scoped, deployment-id targeting derives app/workspace from the deployment and verifies optional caller-supplied ownership, and read-only slug inspection refuses ambiguity instead of choosing one row.

Regression evidence: `control-plane/test/operator-targeting.test.mjs` covers same-slug apps in different workspaces, missing workspace refusal, delete/redeploy targeting, app/workspace mismatch refusal, no-match refusal, app-id/slug mismatch refusal, read-only ambiguity refusal, and legitimate single-workspace flow.

Required next node: `15R.3 Production Tenant-Boundary Wiring`

Provider verification required? No.

Notes: `create-app-deployment.mjs` is a safer exception because it scopes app lookup by repository workspace.

### Tenant-Boundary Assertion Wiring

Reviewer claim: tenant-boundary assertions may exist mostly as tests rather than production controls.

Classification: `PARTIALLY_CONFIRMED`; `RESOLVED_BY_15R_3`

Exact files/functions:

- `control-plane/src/tenant-boundary.mjs`
- `control-plane/trigger/apply-runtime-env.ts`
- `control-plane/trigger/prepare-build-input.ts`
- `control-plane/trigger/detect-env-requirements.ts`
- `control-plane/trigger/execute-build.ts`
- `control-plane/trigger/reconcile-build.ts`
- `control-plane/test/tenant-boundary.test.mjs`

Assertion wiring:

| Assertion | Test Call Sites | Production Call Sites | Meaningful Production Use | Tautological | Production Value Source |
| --- | --- | --- | --- | --- | --- |
| `assertAppInWorkspace` | yes | none | false | n/a | n/a |
| `assertRepositoryInWorkspace` | yes | `prepare-build-input.ts`, `detect-env-requirements.ts` | true | false | repository workspace is checked against deployment workspace before GitHub source reads |
| `assertDeploymentInWorkspace` | yes | none | false | n/a | n/a |
| `assertDeploymentBelongsToApp` | yes | none | false | n/a | n/a |
| `assertSecretBindingBelongsToApp` | yes | `apply-runtime-env.ts` | true | false | independent joined binding and secret columns |
| `assertRuntimeBelongsToApp` | yes | none | false | n/a | n/a |
| `assertRuntimeMatchesDeployment` | yes | `provision-runtime.ts`, `apply-runtime-env.ts`, `execute-build.ts` | true | false | runtime row workspace/app/project identity is checked before provider runtime use |
| `assertProviderBuildBelongsToDeployment` | yes | `reconcile-build.ts` | true | false | local build row source/deployment identity is checked before build reconciliation state mutation |
| `assertProviderOperationBelongsToDeployment` | yes | `execute-build.ts` | true | false | operation ledger row is checked before provider create/recovery continuation |
| `assertSscProviderResourceIdentity` | yes | `execute-build.ts`, `reconcile-build.ts` | true | false | provider deployment metadata is checked before local build attachment/reconciliation |

Reproduction method: static call-site inspection with `rg`.

Observed result: Node 15R.3 wires meaningful tenant-boundary checks into source preparation/detection, runtime/env injection, build execution, and build reconciliation. App/deployment ownership helpers remain available for future self-service paths where caller-supplied identities meet deployment-derived identities.

Concrete consequence: controlled-alpha production paths now fail before GitHub source reads, secret decrypt/injection, provider deployment creation/attachment, and build reconciliation state mutation when tenant/resource identities diverge.

Required next node: `15R.4 Provider Mutation Concurrency / Fencing`.

Provider verification required? Yes for any CPU, memory, storage, build/runtime, or account-spend limits that must be enforced by Vercel/provider settings rather than SSC database admission checks.

Notes: schema-enforced boundaries remain documented separately; no broad authorization framework or PostgreSQL RLS was added.

### P1-A - Duplicate Provider Deployment Creation Under Concurrent Execution

Reviewer claim: concurrent `execute-build` calls for the same deployment can create duplicate Vercel deployments.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_4`

Exact files/functions:

- `control-plane/trigger/execute-build.ts`: `ensureBuildOperation`, `listCandidateDeployments`, `buildRecoveryAction`, Vercel `POST /v13/deployments`.
- `control-plane/db/013_provider_operations.sql`: unique operation rows exist but do not fence concurrent side effects.

Reproduction method: two mocked workers call `execute-build` for the same deployment. Both see no `deployment_builds` row. The first inserts `INTENT_RECORDED`; the second receives the same operation through `ON CONFLICT`. If both list provider candidates before either updates the operation to `CREATE_REQUESTED` or before provider visibility exists, both compute `action=create` and both can call Vercel create.

Observed result:

```text
PROVIDER_CREATE_CALL_COUNT = 2 possible
```

Concrete consequence: two provider deployments can exist for one SSC deployment identity. Later replay detects ambiguity, but the duplicate provider side effect has already occurred.

Resolution: Node `15R.4 Provider Mutation Concurrency / Fencing` adds an atomic `deployment_provider_operations` claim transition before Vercel deployment creation. Concurrent workers that observe the same logical operation after it has been claimed return an in-flight/no-create result instead of issuing another provider create call.

Regression evidence: `control-plane/test/provider-mutation-fencing.test.mjs` reproduces the pre-fix duplicate create decision count of `2` and proves the atomic claim permits exactly one creator.

Required next node: `15R.4 Provider Operation Concurrency Fencing`

Provider verification required? No.

Notes: the ledger prevents lost-response replay duplication, but it is not an in-flight concurrency lock.

### P1-B - Delete/Provision Or Abandon/Build Race Can Leave Residual Provider State

Reviewer claim: lifecycle workers can race with delete/abandon and leave provider resources after local state moved terminal.

Classification: `CONFIRMED`; `STATE_SAFETY_RESOLVED_BY_15R_4`; `REMOTE_CANCELLATION_RESOLVED_BY_15R_5`

Exact files/functions:

- `control-plane/trigger/provision-runtime.ts`
- `control-plane/trigger/delete-app.ts`
- `control-plane/trigger/abandon-deployment.ts`
- `control-plane/trigger/execute-build.ts`

Reproduction method:

- Delete/provision: `provision-runtime.ts` reads `PROVISIONING`, then awaits Vercel project create/reconcile outside a transaction. During that await, `delete-app.ts` can mark deployments `DELETING`, delete provider project/runtime bindings/secrets, and soft-delete the app. The stale provision worker can then insert an `app_runtimes` row and may have created or adopted a provider project after deletion.
- Abandon/build: `execute-build.ts` reads `BUILDING`, records intent, and can await Vercel create while `abandon-deployment.ts` marks the deployment `FAILED`. The stale build worker then attaches provider build/operation evidence even though the deployment update is guarded by `WHERE status='BUILDING'`.

Observed result: provider resource creation can complete after local deletion or abandonment. Some state remains traceable by runtime/build/operation rows, but the provider side effect occurs after the operator's terminal decision.

Concrete consequence: residual provider project/deployment clutter, cost, or ambiguity; possible unexpected workload execution after abandonment.

Resolution: Node `15R.4 Provider Mutation Concurrency / Fencing` moves abandonment locking inside a transaction, claims app deletion before provider deletion, revalidates app/deployment state before runtime insertion, revalidates deployment/provider-operation state before build attachment, and records stale provider results as traceable events/operation evidence instead of reviving active lifecycle state.

Regression evidence: `control-plane/test/provider-mutation-fencing.test.mjs` covers stale build result fencing, stale runtime result fencing, delete transaction locking, abandon transaction locking, independent app/deployment claims, and provider response-loss reconciliation.

Required next node: `15R.5 Build Timeout + Remote Cancellation`

Provider verification required? No.

Notes: Node 15R.5 adds remote build containment for abandoned in-flight provider deployments while preserving the 15R.4 stale-worker fencing.

### P1-C - Build Timeout / Abandonment Does Not Cancel Provider-Side Execution

Reviewer claim: SSC marks timeout/abandon locally but does not cancel the remote Vercel deployment.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_5`

Exact files/functions:

- `control-plane/trigger/orchestrate-deployment.ts`: `failBuildTimeout`
- `control-plane/trigger/abandon-deployment.ts`
- `control-plane/trigger/delete-app.ts`
- `control-plane/src/vercel-deployment-cancellation.mjs`

Reproduction method: static search for Vercel deployment cancellation API usage and timeout/abandon paths.

Observed pre-15R.5 result:

```text
ON_SSC_BUILD_TIMEOUT_PROVIDER_CANCELLATION_CALLED = no
ON_ABANDON_PROVIDER_CANCELLATION_CALLED = no
REMOTE_BUILD_CAN_CONTINUE_AFTER_LOCAL_FAILED_OR_ABANDONED = true
```

Concrete consequence: provider build/runtime execution may continue after SSC has marked the deployment failed/abandoned.

Resolution: Node 15R.5 verifies Vercel deployment cancellation semantics and adds bounded remote containment for build timeout and abandonment paths. Timeout uses the persisted `deployment_builds.created_at` timestamp instead of an invocation-local clock, records `PROVIDER_CANCEL_REQUESTED`, and then records one normalized terminal containment event: `PROVIDER_CANCEL_CONFIRMED`, `PROVIDER_ALREADY_TERMINAL`, or `PROVIDER_CANCEL_FAILED`. Replays reuse existing final containment evidence and do not create new provider deployments.

Provider behavior verified from Vercel documentation: `PATCH /v12/deployments/{id}/cancel` cancels in-progress deployments; already `READY`, `ERROR`, or `CANCELED` deployments are no longer cancelable. SSC first reads provider status, cancels only potentially active deployments, reconciles after the cancel request when needed, and treats provider `404` as safe when deletion won the race.

Economic note: `max_build_minutes` is an SSC orchestration deadline and cancellation trigger. It is not a guaranteed hard provider-spend cutoff; provider billing containment also depends on successful provider cancellation and Vercel account/project limits.

Required next node: none for remote build cancellation; continue with `15R.6 Git Auto-Deploy Containment`.

Provider verification required? Vercel cancellation endpoint/status semantics were verified from provider documentation for implementation. Token permission scope still belongs to the broader provider-scope verification track.

Notes: app deletion still deletes the whole Vercel project. If deletion wins the race and the deployment lookup returns not found, cancellation is recorded as already terminal/absent rather than as a confirmed cancel.

### P1-D - Git Auto-Deployment Prevention Is Not Actually Established In Production

Reviewer claim: SSC does not actually prove Git auto-deploys are disabled for production runtimes.

Classification: `CONFIRMED_PROVIDER_DEPENDENT`; `RESOLVED_BY_15R_6`

Exact files/functions:

- `control-plane/src/vercel-project-config.mjs`
- `control-plane/trigger/provision-runtime.ts`
- `control-plane/trigger/apply-runtime-env.ts`
- `control-plane/trigger/execute-build.ts`
- `control-plane/test/deployment-recovery-rules.test.mjs`
- `control-plane/test/vercel-project-config.test.mjs`

Reproduction method: static production-call inspection.

Observed result:

- `sscManagedProjectGitSettings()` returns only `{ skipGitConnectDuringLink: true }`.
- `provision-runtime.ts` uses `sscManagedProjectGitSettings()` when creating a project.
- `disableGitAutoDeploymentsBody()` is not called in the production runtime provisioning path.
- `gitAutoDeploymentsDisabled()` is not checked in `provision-runtime.ts` before adopting an existing remote project.

Concrete consequence: whether Git auto-deploys are prevented depends on Vercel semantics and actual project settings, not a repository-proven production invariant.

Resolution: Node 15R.6 establishes a code-level invariant for controlled-alpha production paths. SSC verifies project identity first, then requires Vercel Git auto-deploy containment before runtime adoption/attachment, before secret decryption/env injection, and before provider deployment creation. Live disposable verification showed connected projects may report `git=null` with `link` present, and `PATCH /v9/projects/{id}` with `git.deploymentEnabled=false` returns HTTP 400 through SSC's current REST path. SSC now treats only absent/disconnected project Git linkage as safe; connected or unknown state fails closed with an explicit disconnect-required result.

Provider behavior verified live: SSC's attempted project PATCH path cannot correct `deploymentEnabled` for the disposable connected project. A supported provider disconnect operation is available at the provider level, but SSC will not silently disconnect production projects until such an operation is separately reviewed and wired.

Required next node: none for code-level Git auto-deploy containment; continue with `15R.7 Source + LIVE Deployment Identity`.

Provider verification required? Complete for controlled alpha. The disposable `ssc-ssc-recovery-test` Vercel project (`prj_vVfWE0VMyYvABEUkQFa3X8oEYOhj`) was manually disconnected from `kp080681/ssc-lifecycle-test`, then API-verified as `git:null` and `link:null`. Baseline provider deployment count was 3 and latest deployment was `dpl_231x5RiipsGgzEqaVG7NmdnD47Sm`. After a harmless empty commit to `kp080681/ssc-lifecycle-test` `main`, the provider deployment list remained status 200, count 3, latest deployment `dpl_231x5RiipsGgzEqaVG7NmdnD47Sm`. The Git push created zero out-of-band Vercel deployments.

Notes: unknown provider Git state is not treated as safe. Explicit disconnected projects (`git: null`, `link: null`) are safe; connected or omitted state must be manually disconnected or blocked before use.

### P1-E - Build/Source Reconciliation Can Pass With Missing Independently Observed Source Identity

Reviewer claim: provider build reconciliation can advance when no independent source SHA is observed.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_7`

Exact files/functions:

- `control-plane/trigger/reconcile-build.ts`: `providerCommitSha`, `sourceIdentityMatches`, `buildReconciliationAction`.

Reproduction method: mocked provider deployment has `readyState = READY` and no `meta.githubCommitSha`, `gitSource.sha`, `gitSource.ref`, or `meta.sscSourceCommitSha`.

Observed result: `observedSha = null`; source mismatch block is skipped; `buildReconciliationAction({ providerStatus: "READY" })` advances to `DEPLOYING`; return reports `sourceIdentityMatches = null`.

Concrete consequence: pre-15R.7 `BUILD_VERIFIED` / `BUILD_SUCCEEDED` could occur without independently proving provider source identity.

Resolution: Node 15R.7 introduces `control-plane/src/vercel-deployment-identity.mjs`, separates SSC-submitted metadata from provider-observed Git/source facts, and changes build reconciliation so provider `READY` plus missing independent source evidence records `SOURCE_IDENTITY_UNAVAILABLE` / `BUILD_SOURCE_UNVERIFIED` instead of advancing. Wrong source remains `BUILD_SOURCE_MISMATCH`. Provider deployment id, project id, and SSC deployment id must also match before build reconciliation can verify.

Regression evidence: `control-plane/test/vercel-deployment-identity.test.mjs` covers expected source SHA, wrong source SHA, missing independent source SHA, self-submitted-only metadata, wrong provider project, wrong SSC deployment id, and unknown identity fail-closed behavior. `control-plane/test/deployment-recovery-rules.test.mjs` covers the source-unverified recovery decision.

Required next node: none for source/live identity; continue with `15R.8 Secret Environment Boundary`.

Provider verification required? No for fail-open reproduction; provider docs may help choose the strongest observed identity field.

Notes: SSC-submitted metadata exists at create time, but reconciliation should not treat missing observed identity as success.

### P1-F - Canonical Production URL Verification Can Mark LIVE Without Proving It Serves The Intended Provider Deployment

Reviewer claim: public verification proves URL reachability but not exact deployment identity.

Classification: `CONFIRMED`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_7`

Exact files/functions:

- `control-plane/trigger/configure-public-access.ts`: chooses project/canonical host and performs anonymous GET.

Reproduction method: mocked Vercel deployment is `READY` and `target=production`, project host returns HTTP 200, but the host could be serving an older or different deployment. The response check contains no provider deployment id, deployment protection bypass identity, alias assignment proof, or response-level provenance.

Observed result:

```text
LIVE_VERIFICATION_PROVES = REACHABILITY_ONLY plus provider deployment READY target check
DEPLOYMENT_IDENTITY_AND_REACHABILITY_PROVEN = false
```

Concrete consequence: pre-15R.7 SSC could mark `LIVE` when the canonical host was reachable but not proven to serve the exact provider deployment id being marked live.

Resolution: Node 15R.7 changes `control-plane/trigger/configure-public-access.ts` so `LIVE` requires a verified build row, matching provider deployment identity, provider-observed source identity, Vercel alias/deployment-alias binding to the exact provider deployment, and anonymous reachability. A stale canonical URL returning HTTP 200 now records `PUBLIC_BINDING_UNVERIFIED` and does not mark the new deployment `LIVE`.

Provider proof used: Vercel alias APIs expose alias-to-deployment/project identity and deployment alias listings. SSC uses `GET /v4/aliases/{alias}` plus `GET /v2/deployments/{id}/aliases` as code-level proof before the public HTTP check.

Regression evidence: `control-plane/test/vercel-deployment-identity.test.mjs` covers canonical alias match, stale alias to an old deployment, correct binding with failing public health, HTTP 200 without binding proof, omitted provider fields, and a DealUp-style complete mocked provider flow.

Required next node: none for source/live identity; continue with `15R.8 Secret Environment Boundary`.

Provider verification required? Yes, to identify the correct Vercel alias/production deployment proof API.

Notes: current behavior is stronger than a blind HTTP 200 because it checks the provider deployment is READY/production, but it does not bind the public hostname response to that deployment id.

### P1-G - Production Secrets Are Applied To Preview As Well As Production

Reviewer claim: production secret bindings are sent to preview and production targets.

Classification: `CONFIRMED`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_8`

Exact files/functions:

- `control-plane/trigger/apply-runtime-env.ts`: `const providerTargets = ["preview", "production"]`.

Reproduction method: static production-path inspection.

Observed pre-15R.8 result:

```text
SECRETS_TARGET_PREVIEW = true
```

Concrete consequence: pre-15R.8 app production secrets were exposed to preview deployments/environments for that Vercel project.

Resolution: Node 15R.8 changes runtime environment application so SSC app-secret bindings are written to Vercel with alpha target `["production"]` only. Existing production binding lookup, KMS decrypt behavior, tenant/runtime/provider identity checks, Git auto-deploy containment, plaintext redaction, and provider upsert behavior are preserved. Vercel provider-reported env upsert failures now throw before SSC can record `RUNTIME_ENV_APPLIED`.

Provider behavior verified from Vercel documentation: project environment variables are created through `POST /v10/projects/{idOrName}/env`; the request body includes `target`, and `upsert=true` updates existing variables instead of creating a duplicate. Vercel environment variables are scoped to environments including Production, Preview, Development, and custom environments.

Regression evidence: `control-plane/test/vercel-env-boundary.test.mjs` covers new customer secrets, multiple secrets, legacy preview+production target reconciliation via production-only upsert payload, unrelated provider env non-cleanup, public `NEXT_PUBLIC_*` name classification, private secret naming, identity-before-decrypt ordering, provider failure refusal, and production deployment fixture compatibility.

Required next node: none for secret environment target boundary; continue with `15R.9 Reproducible Dependencies / Lockfile`.

Provider verification required? Yes. 15R.13 must inspect live DealUp/Vantage projects, confirm existing SSC-managed env targets no longer leave production secrets preview-accessible after approved reconciliation, confirm production builds receive production-target env vars, and confirm no Vercel team-level/shared control-plane credentials are inherited by customer projects.

Notes: this is not a plaintext leak in logs, but it broadens runtime exposure.

### P1-H - Resource Policy Enforcement Occurs After Secret Injection / Provider Mutation

Reviewer claim: a deployment that ultimately fails resource policy may already have provider mutations and secret injection.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_11`

Exact files/functions:

- `control-plane/trigger/orchestrate-deployment.ts`
- `control-plane/trigger/provision-runtime.ts`
- `control-plane/trigger/apply-runtime-env.ts`
- `control-plane/trigger/enforce-resource-policy.ts`

Reproduction method: state-machine trace.

Observed result:

```text
PROVISION_RUNTIME -> APPLY_RUNTIME_ENV -> ENFORCE_RESOURCE_POLICY -> EXECUTE_BUILD
RESOURCE_POLICY_BEFORE_SECRET_INJECTION = false
```

Concrete consequence: policy-blocked deployments may already have created/reconciled a provider project and applied secrets before policy enforcement blocks build execution.

Resolution: Node 15R.11 moves resource policy verification before runtime secret application and provider build creation in `orchestrate-deployment.ts`. The V1 policy that is actually enforceable in SSC now blocks before decrypting/applying runtime secrets. Runtime provisioning still precedes policy verification because Vercel project/resource-limit enforcement remains provider-dependent; SSC does not pretend to enforce CPU, memory, or storage settings that are not established in the current provider abstraction.

Required next node: none for secret-injection/build ordering; provider resource-limit verification remains part of 15R.13 live provider review.

Provider verification required? Yes for any CPU, memory, storage, build/runtime, or account-spend limits that must be enforced by Vercel/provider settings rather than SSC database admission checks.

Notes: Node 04.17 correctly blocks missing required configuration before provisioning; this finding is about resource policy order, not env requirement verification.

### P1-I - Control-Plane Dependency Graph Is Not Reproducibly Locked

Reviewer claim: control-plane install/deploy dependencies are not frozen by a tracked lockfile.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_9`

Exact files/functions:

- `control-plane/package.json`
- `control-plane/trigger.config.ts`

Reproduction method: repository file inventory.

Observed pre-15R.9 result:

```text
LOCKFILE_TRACKED = false
FROZEN_INSTALL_USED = false
```

Concrete consequence: pre-15R.9 Trigger/control-plane deployments could resolve dependency versions differently over time.

Resolution: Node 15R.9 adds a tracked npm lockfile at `control-plane/package-lock.json` using lockfile version 3 and validates `npm ci` as the frozen control-plane install command. `control-plane/package.json` dependency ranges were not changed. The repository ignore rules now exclude `node_modules/`, local `.env` files, and PEM private-key material while still allowing `.env.example` and `.env.sample`.

Audit evidence: `npm ci` completes from the lockfile without rewriting it. The control-plane package has no first-party `preinstall`, `install`, `postinstall`, or `prepare` lifecycle scripts. `npm audit --omit=dev` reports no critical production/runtime findings and one high transitive `ws` finding through Trigger SDK/socket.io-client/OpenTelemetry. Full `npm audit` reports 25 total advisories, including a critical transitive `tar` path through the `trigger.dev` CLI/dev tooling. No package upgrades were made because the available npm audit fixes imply major Trigger package changes and should be handled as deliberate dependency modernization.

Required next node: none for lockfile reproducibility; continue with `15R.10 Recovery Safety Corrections`.

Provider verification required? No.

Notes: Trigger.dev dependency install behavior should still be verified during 15R.13 live provider/deploy review, but the repository now provides a deterministic npm dependency graph for tools that honor the committed lockfile.

### P1-J - Restore Target Protection Can Allow Production-Equivalent Connection Strings

Reviewer claim: disposable restore guard compares raw connection strings and can miss equivalent source/restore targets.

Classification: `CONFIRMED`; `RESOLVED_CODE_PENDING_NEW_DRILL_BY_15R_10`

Exact files/functions:

- `control-plane/scripts/restore-control-plane-db-disposable.mjs`

Reproduction method: string-only guard inspection.

Observed pre-15R.10 result:

- The guard refuses only when `process.env.DATABASE_URL === restoreDatabaseUrl`.
- `DATABASE_URL` absent is allowed and no source/restore comparison occurs.
- Same database with benign query-string/order differences, alternate host aliases, URL encoding differences, or equivalent pooled/unpooled endpoints can pass the raw string comparison.

Concrete consequence: operator error could restore over a production-equivalent target despite the disposable confirmation phrase.

Resolution: Node 15R.10 adds a canonical restore target guard and requires an independently supplied `CONTROL_PLANE_RESTORE_TARGET_IDENTITY` that must match the password-free identity derived from `RESTORE_DATABASE_URL`. The guard refuses textually different same-database targets, including reordered query parameters and common Neon pooled/direct host variants for the same endpoint/database/user. The restore script now also requires `CONTROL_PLANE_BACKUP_SHA256` and verifies the backup digest before invoking `pg_restore`.

New drill requirement: because this node did not rerun a real disposable restore, the next operator drill must use the new identity/digest guard and record that it refused a production-equivalent target and accepted only the approved disposable target.

Required next node: none for code-level restore target equivalence; continue with `15R.11 Workspace / Economic Guardrails`.

Provider verification required? No, though Neon endpoint equivalence may need operator/provider confirmation for robust checks.

Notes: the restore script is already confirmation-gated; this finding is about target equivalence strength.

### P1-K - Restored-Secret Decrypt Verification Calls Decrypt Helper Incorrectly

Reviewer claim: functional restore verifier uses the wrong `decryptAppSecret` call shape.

Classification: `CONFIRMED`; `RESOLVED_BY_15R_10`

Exact files/functions:

- `control-plane/scripts/verify-restored-control-plane-functional.mjs`
- `control-plane/src/secret-store.mjs`

Reproduction method: static signature comparison.

Observed pre-15R.10 result:

```text
decryptAppSecret signature = decryptAppSecret(db, { appId, name })
verifier call = decryptAppSecret(db, row.app_id, row.name)
DECRYPT_TEST_CALL_VALID = false
```

Concrete consequence: if the optional decrypt branch is enabled with a deterministic test secret and expected digest, it will not call the helper correctly.

Resolution: Node 15R.10 changes the verifier to call `decryptAppSecret(db, { appId: row.app_id, name: row.name })`. The optional decrypt branch remains gated to an explicitly named backup/restore/recovery test secret plus an expected SHA-256 digest. If no safe expected digest is supplied, the verifier reports metadata-only recovery rather than inventing a plaintext proof. If a digest check is attempted and mismatches, the verifier exits nonzero without printing plaintext.

Required next node: none for restored-secret decrypt helper correctness; continue with `15R.11 Workspace / Economic Guardrails`.

Provider verification required? No.

Notes: Node 18 drill reported `SECRET_RECOVERY = METADATA_ONLY`, so this did not invalidate the completed metadata-only restore evidence.

### P1-L - Workspace-Level Economic / Admission Limits Are Absent Or Insufficient

Reviewer claim: one workspace can multiply per-app limits by creating many apps.

Classification: `PARTIALLY_CONFIRMED`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_11`

Exact files/functions:

- `control-plane/db/010_app_resource_policies.sql`
- `control-plane/db/015_workspace_resource_policies.sql`
- `control-plane/src/workspace-resource-policy.mjs`
- `control-plane/trigger/enforce-resource-policy.ts`
- `control-plane/trigger/create-redeployment.ts`
- `control-plane/trigger/execute-build.ts`
- `control-plane/trigger/orchestrate-deployment.ts`
- `control-plane/scripts/create-app-deployment.mjs`
- `control-plane/scripts/set-workspace-resource-policy.mjs`

Reproduction method: static schema/flow inspection.

Observed pre-15R.11 result:

| Level | Enforcement |
| --- | --- |
| Deployment | build timeout, health attempts, provider operation recovery, build log cap |
| App | max env vars, max deployments per day through `app_resource_policies` |
| Workspace | absent |
| Global | absent except provider/account limits |

Concrete consequence: under any future public entrypoint, one workspace could create many apps and multiply per-app deployment/provider usage limits.

Resolution: Node 15R.11 adds a small `workspace_resource_policies` table and shared enforcement module. Controlled-alpha defaults are `maxActiveApps=3`, `maxActiveDeployments=3`, `maxActiveDeploymentsPerApp=1`, and `maxConcurrentProviderOperations=2`. Active deployment states are `DRAFT`, `READY`, `QUEUED`, `ANALYZING`, `PROVISIONING`, `BUILDING`, `DEPLOYING`, `HEALTH_CHECKING`, and `DELETING`; terminal/historical `LIVE`, `FAILED`, and `DELETED` deployments do not consume active-deployment concurrency. Deleted apps do not consume active-app quota.

SSC-enforced limits:

- app creation is refused before app insert when the workspace active-app limit is reached
- initial deployment creation and redeploy are refused before deployment insert when app/workspace active-deployment limits are reached
- new Vercel deployment operation intent creation is refused before provider deployment creation when the workspace provider-operation limit is reached
- existing provider-operation recovery/replay can continue while the workspace is at the provider-operation limit
- resource policy verification now runs before runtime secret application and provider build creation in the orchestrator
- explicit founder override is available through `set-workspace-resource-policy.mjs` with workspace-id targeting and numeric validation

Provider-dependent limits still requiring live verification:

- Vercel account/team spend controls, build/runtime limits, and project-level usage controls
- Trigger.dev task concurrency/usage controls
- AWS KMS usage/cost controls
- Neon/customer database project/storage limits once 15R.12 resolves PostgreSQL lifecycle scope

Required next node: none for workspace admission/economic guardrail code; continue with `15R.12 Production PostgreSQL Scope Decision`.

Provider verification required? Yes for provider-account spend and runtime resource controls. SSC now enforces bounded workspace admission/concurrency in code, but it does not claim CPU, memory, storage, or provider-account spend ceilings that are not directly enforced by this control plane.

Notes: this is not billing, pricing, or usage metering. It is a founder-controlled alpha safety boundary.

### P1-M - Customer PostgreSQL Provisioning Is Not Implemented In Production Lifecycle

Reviewer claim: SSC V1 advertises PostgreSQL support, but production lifecycle does not provision customer PostgreSQL.

Classification: `CONFIRMED`; `SCOPED_BY_15R_12`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_12A`

Exact files/functions:

- `control-plane/db/001_initial_schema.sql`: original `app_databases` placeholder table.
- `control-plane/db/016_managed_customer_databases.sql`: explicit database modes, managed database identity columns, reconciliation key, status metadata, and workspace managed database limit.
- `control-plane/src/project-detection.mjs`: detects database requirement from dependencies.
- `control-plane/src/deployment-state.mjs`: can route database-required analysis to `PROVISIONING`.
- `control-plane/src/managed-database-lifecycle.mjs`: explicit ownership, deterministic managed database identity, intent/claim helpers, encrypted `DATABASE_URL` persistence, and ownership-aware delete.
- `control-plane/src/neon-managed-postgres.mjs`: bounded Neon provider adapter.
- `control-plane/trigger/provision-database.ts`: production managed PostgreSQL provisioning/reconciliation task.
- `control-plane/trigger/orchestrate-deployment.ts`: calls managed database provisioning before runtime provisioning, env injection, and build.
- `control-plane/trigger/delete-app.ts`: deletes only verified `SSC_MANAGED` database resources and skips `NONE`/`EXTERNAL`.
- `docs/03-architecture-spike/SPIKE-C-RESULTS.md`: real Neon spike proof.

Reproduction method: repository search for customer database lifecycle create/reconcile/credential generation/app binding/delete.

Observed result:

```text
CUSTOMER_POSTGRESQL_PROVISIONING = PRODUCTION_WIRED_PENDING_LIVE_VERIFY
```

Concrete consequence before 15R.12A: a workload requiring SSC-provisioned PostgreSQL could not be deployed through the production control-plane lifecycle without using an existing external database/secret path.

Decision: Node 15R.12 selected explicit database ownership modes for controlled alpha. Node 15R.12A implements `NONE`, `EXTERNAL`, and `SSC_MANAGED` production wiring while preserving existing no-database and external-database workload safety.

Resolution: Node 15R.12A adds explicit `NONE`, `EXTERNAL`, and `SSC_MANAGED` database modes, a managed database resource record, workspace managed database admission limit, durable create intent/claim, Neon provisioning/reconciliation, encrypted generated `DATABASE_URL`, production-only binding, ownership-aware deletion, and read-only managed database inventory/orphan classification. Node 15R.12B proves provider-native recovery for a disposable SSC-managed Neon PostgreSQL database using branch restore to a captured LSN, with exact row-count and digest parity after destructive mutation. Node 15R.13 records live provider configuration evidence and accepts remaining provider limitations for founder-operated controlled alpha.

Required next node: `PRE_15R_14_LIVE_ACTIVATION`

Provider verification required? Yes before external alpha, to validate current Neon API token scope, account/project limits, delete semantics, and backup/PITR behavior.

Notes: this is a product-contract gap more than a hostile-code bug, but it is alpha-relevant because PostgreSQL is in SSC V1 scope.

## Final Frozen Remediation Table

| Frozen ID | Source Finding | Classification | Required Next Node | Summary |
| --- | --- | --- | --- | --- |
| `15R-F01` | P0-A | `CONFIRMED`; `RESOLVED_BY_15R_1` | `15R.1` | Slug-only Vercel project naming/adoption crosses workspaces |
| `15R-F02` | P0-B | `CONFIRMED`; `RESOLVED_BY_15R_2` | `15R.2` | Mutating operator scripts now require workspace-scoped app targeting or immutable deployment id targeting |
| `15R-F03` | Tenant-boundary assertion wiring | `PARTIALLY_CONFIRMED`; `RESOLVED_BY_15R_3` | `15R.3` | Meaningful tenant-boundary assertions are wired into controlled-alpha source, runtime, secret, build, and provider-resource paths |
| `15R-F04` | P1-A | `CONFIRMED`; `RESOLVED_BY_15R_4` | `15R.4` | Atomic provider-operation claim prevents duplicate Vercel deployment creation for one logical operation |
| `15R-F05` | P1-B | `CONFIRMED`; `STATE_SAFETY_RESOLVED_BY_15R_4`; `REMOTE_CANCELLATION_RESOLVED_BY_15R_5` | `15R.5` | Delete/provision and abandon/build races cannot revive active state; abandoned in-flight provider deployments now receive remote containment attempts |
| `15R-F06` | P1-C | `CONFIRMED`; `RESOLVED_BY_15R_5` | `15R.5` | Timeout/abandon now requests and records provider build containment instead of only marking local state |
| `15R-F07` | P1-D | `CONFIRMED_PROVIDER_DEPENDENT`; `RESOLVED_BY_15R_6` | `15R.6` | Production paths now require disconnected Git linkage before runtime use, secret injection, and build creation; connected or unknown projects fail closed; live disposable proof confirmed a disconnected project did not auto-deploy on Git push |
| `15R-F08` | P1-E | `CONFIRMED`; `RESOLVED_BY_15R_7` | `15R.7` | Build verification now requires provider-observed source identity matching the immutable build input |
| `15R-F09` | P1-F | `CONFIRMED`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_7` | `15R.7` | Public URL verification now requires provider alias/binding proof for the exact deployment before reachability can mark LIVE |
| `15R-F10` | P1-G | `CONFIRMED`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_8` | `15R.8` | Runtime env application now targets production only; live project env/shared-env verification remains required |
| `15R-F11` | P1-H | `CONFIRMED`; `RESOLVED_BY_15R_11` | none | Enforceable resource policy now runs before runtime secret application and provider build creation; provider CPU/memory/storage controls remain live-verification dependent |
| `15R-F12` | P1-I | `CONFIRMED`; `RESOLVED_BY_15R_9` | `15R.9` | Control-plane npm dependencies are locked by tracked `control-plane/package-lock.json`; audit findings remain for deliberate upgrade review |
| `15R-F13` | P1-J | `CONFIRMED`; `RESOLVED_CODE_PENDING_NEW_DRILL_BY_15R_10` | none | Restore guard now requires independent disposable target identity, canonical same-database refusal, and backup SHA-256 verification before restore |
| `15R-F14` | P1-K | `CONFIRMED`; `RESOLVED_BY_15R_10` | none | Optional restored-secret decrypt branch now calls `decryptAppSecret(db, { appId, name })` and fails digest mismatch without plaintext output |
| `15R-F15` | P1-L | `PARTIALLY_CONFIRMED`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_11` | none | Workspace active app, deployment, and provider-operation admission limits now exist; provider-account spend/resource controls remain live-verification dependent |
| `15R-F16` | P1-M | `CONFIRMED`; `SCOPED_BY_15R_12`; `RESOLVED_CODE_PENDING_LIVE_VERIFY_BY_15R_12A`; `RECOVERY_PROOF_PASS_BY_15R_12B`; `PROVIDER_CONFIG_PASS_WITH_LIMITATIONS_BY_15R_13` | `PRE_15R_14_LIVE_ACTIVATION` | Customer PostgreSQL provisioning is production-wired with explicit ownership; disposable provider-native recovery proof passed; provider configuration verified with documented limitations |

No speculative remediation nodes were added beyond reproduced findings. The 15R remediation sequence is complete through provider configuration verification, with documented limitations and remaining live activation actions before independent adversarial re-review.

## Final Status

`P0_A_PROJECT_ADOPTION = CONFIRMED`

`P0_B_OPERATOR_TARGETING = RESOLVED_BY_15R_2`

`TENANT_ASSERTIONS_PRODUCTION_WIRING = RESOLVED_BY_15R_3`

`DUPLICATE_PROVIDER_CREATE = RESOLVED_BY_15R_4`

`DELETE_PROVISION_RACE = STATE_SAFETY_RESOLVED_BY_15R_4`

`ABANDON_BUILD_RACE = STATE_SAFETY_RESOLVED_BY_15R_4`

`REMOTE_BUILD_CANCELLATION = RESOLVED_BY_15R_5`

`GIT_AUTODEPLOY_CONTAINMENT = PASS_DISCONNECTED_NO_AUTODEPLOY_OBSERVED`

`SOURCE_IDENTITY_FAIL_OPEN = RESOLVED_BY_15R_7`

`LIVE_IDENTITY_PROOF = RESOLVED_CODE_PENDING_LIVE_VERIFY`

`SECRETS_TARGET_PREVIEW = false`

`RESOURCE_POLICY_BEFORE_SECRET_INJECTION = true`

`LOCKFILE_TRACKED = true`

`RESTORE_PRODUCTION_EQUIVALENCE_GUARD = RESOLVED_CODE_PENDING_NEW_DRILL`

`RESTORED_SECRET_DECRYPT_CALL = VALID`

`WORKSPACE_RESOURCE_LIMIT = RESOLVED_CODE_PENDING_LIVE_VERIFY`

`CUSTOMER_POSTGRESQL_PROVISIONING = PRODUCTION_WIRED_PENDING_LIVE_VERIFY`

`PROVIDER_NATIVE_RECOVERY_VERIFIED = true`

`SSC_MANAGED_DATABASE_RECOVERY_STATUS = PASS`

`PROVIDER_CONFIGURATION_VERIFICATION = PASS_WITH_DOCUMENTED_LIMITATIONS`

`GITHUB_PROVIDER_STATUS = PASS`

`VERCEL_CREDENTIAL_LEAST_PRIVILEGE = PARTIAL`

`VERCEL_GIT_AUTODEPLOY_LIVE = PASS_DISCONNECTED_NO_AUTODEPLOY_OBSERVED`

`AWS_KMS_PROVIDER_STATUS = PASS`

`TRIGGER_PROVIDER_STATUS = PASS_WITH_ROOT_KEY_LIMITATION`

`NEON_PROVIDER_STATUS = PASS_WITH_ORG_WIDE_KEY_LIMITATION`

`CONTROLLED_ALPHA_INFRA_BUDGET_USD = 100`

`PROVIDER_PREEMPTIVE_UPGRADES_ALLOWED = false`

`CONFIRMED_P0_COUNT = 2`

`CONFIRMED_P1_COUNT = 11`

`PROVIDER_DEPENDENT_COUNT = 1`

`REJECTED_FINDING_COUNT = 0`

`NEXT_NODE = PRE_15R_14_LIVE_ACTIVATION`

`NODE_15R_13_COMPLETE = true`

`NODE_15R_0_COMPLETE = true`

`PRODUCTION_CODE_CHANGED = false`

`PROVIDER_STATE_MUTATED = false`

`DATABASE_STATE_MUTATED = false`

`PUSHED = false`
