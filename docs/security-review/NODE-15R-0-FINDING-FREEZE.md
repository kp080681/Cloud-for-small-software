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

Classification: `CONFIRMED`

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

Provider verification required? No.

Notes: schema-enforced boundaries remain documented separately; no broad authorization framework or PostgreSQL RLS was added.

### P1-A - Duplicate Provider Deployment Creation Under Concurrent Execution

Reviewer claim: concurrent `execute-build` calls for the same deployment can create duplicate Vercel deployments.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/trigger/execute-build.ts`: `ensureBuildOperation`, `listCandidateDeployments`, `buildRecoveryAction`, Vercel `POST /v13/deployments`.
- `control-plane/db/013_provider_operations.sql`: unique operation rows exist but do not fence concurrent side effects.

Reproduction method: two mocked workers call `execute-build` for the same deployment. Both see no `deployment_builds` row. The first inserts `INTENT_RECORDED`; the second receives the same operation through `ON CONFLICT`. If both list provider candidates before either updates the operation to `CREATE_REQUESTED` or before provider visibility exists, both compute `action=create` and both can call Vercel create.

Observed result:

```text
PROVIDER_CREATE_CALL_COUNT = 2 possible
```

Concrete consequence: two provider deployments can exist for one SSC deployment identity. Later replay detects ambiguity, but the duplicate provider side effect has already occurred.

Required next node: `15R.2 Provider Operation Concurrency Fencing`

Provider verification required? No.

Notes: the ledger prevents lost-response replay duplication, but it is not an in-flight concurrency lock.

### P1-B - Delete/Provision Or Abandon/Build Race Can Leave Residual Provider State

Reviewer claim: lifecycle workers can race with delete/abandon and leave provider resources after local state moved terminal.

Classification: `CONFIRMED`

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

Required next node: `15R.2 Provider Operation Concurrency Fencing`

Provider verification required? No.

Notes: `abandon-deployment.ts` performs `SELECT ... FOR UPDATE` before `BEGIN`, so the row lock is not held across its update on normal autocommit PostgreSQL clients.

### P1-C - Build Timeout / Abandonment Does Not Cancel Provider-Side Execution

Reviewer claim: SSC marks timeout/abandon locally but does not cancel the remote Vercel deployment.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/trigger/orchestrate-deployment.ts`: `failBuildTimeout`
- `control-plane/trigger/abandon-deployment.ts`
- `control-plane/trigger/delete-app.ts`

Reproduction method: static search for Vercel deployment cancellation API usage and timeout/abandon paths.

Observed result:

```text
ON_SSC_BUILD_TIMEOUT_PROVIDER_CANCELLATION_CALLED = no
ON_ABANDON_PROVIDER_CANCELLATION_CALLED = no
REMOTE_BUILD_CAN_CONTINUE_AFTER_LOCAL_FAILED_OR_ABANDONED = true
```

Concrete consequence: provider build/runtime execution may continue after SSC has marked the deployment failed/abandoned.

Required next node: `15R.3 Provider Build Cancellation Semantics`

Provider verification required? Yes, to verify exact Vercel cancellation API, states, and permissions before implementation.

Notes: app deletion deletes the whole Vercel project, but timeout/abandon do not cancel an individual deployment.

### P1-D - Git Auto-Deployment Prevention Is Not Actually Established In Production

Reviewer claim: SSC does not actually prove Git auto-deploys are disabled for production runtimes.

Classification: `CONFIRMED_PROVIDER_DEPENDENT`

Exact files/functions:

- `control-plane/src/vercel-project-config.mjs`
- `control-plane/trigger/provision-runtime.ts`
- `control-plane/test/deployment-recovery-rules.test.mjs`

Reproduction method: static production-call inspection.

Observed result:

- `sscManagedProjectGitSettings()` returns only `{ skipGitConnectDuringLink: true }`.
- `provision-runtime.ts` uses `sscManagedProjectGitSettings()` when creating a project.
- `disableGitAutoDeploymentsBody()` is not called in the production runtime provisioning path.
- `gitAutoDeploymentsDisabled()` is not checked in `provision-runtime.ts` before adopting an existing remote project.

Concrete consequence: whether Git auto-deploys are prevented depends on Vercel semantics and actual project settings, not a repository-proven production invariant.

Required next node: `15R.4 Git Auto-Deploy Containment`

Provider verification required? Yes.

Notes: existing tests prove the helper's desired classification, not production enforcement.

### P1-E - Build/Source Reconciliation Can Pass With Missing Independently Observed Source Identity

Reviewer claim: provider build reconciliation can advance when no independent source SHA is observed.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/trigger/reconcile-build.ts`: `providerCommitSha`, `sourceIdentityMatches`, `buildReconciliationAction`.

Reproduction method: mocked provider deployment has `readyState = READY` and no `meta.githubCommitSha`, `gitSource.sha`, `gitSource.ref`, or `meta.sscSourceCommitSha`.

Observed result: `observedSha = null`; source mismatch block is skipped; `buildReconciliationAction({ providerStatus: "READY" })` advances to `DEPLOYING`; return reports `sourceIdentityMatches = null`.

Concrete consequence: `BUILD_VERIFIED` / `BUILD_SUCCEEDED` can occur without independently proving provider source identity.

Required next node: `15R.5 Build Source Identity Must Be Proven`

Provider verification required? No for fail-open reproduction; provider docs may help choose the strongest observed identity field.

Notes: SSC-submitted metadata exists at create time, but reconciliation should not treat missing observed identity as success.

### P1-F - Canonical Production URL Verification Can Mark LIVE Without Proving It Serves The Intended Provider Deployment

Reviewer claim: public verification proves URL reachability but not exact deployment identity.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/trigger/configure-public-access.ts`: chooses project/canonical host and performs anonymous GET.

Reproduction method: mocked Vercel deployment is `READY` and `target=production`, project host returns HTTP 200, but the host could be serving an older or different deployment. The response check contains no provider deployment id, deployment protection bypass identity, alias assignment proof, or response-level provenance.

Observed result:

```text
LIVE_VERIFICATION_PROVES = REACHABILITY_ONLY plus provider deployment READY target check
DEPLOYMENT_IDENTITY_AND_REACHABILITY_PROVEN = false
```

Concrete consequence: SSC can mark `LIVE` when the canonical host is reachable but not proven to serve the exact provider deployment id being marked live.

Required next node: `15R.6 Live URL Deployment Identity Proof`

Provider verification required? Yes, to identify the correct Vercel alias/production deployment proof API.

Notes: current behavior is stronger than a blind HTTP 200 because it checks the provider deployment is READY/production, but it does not bind the public hostname response to that deployment id.

### P1-G - Production Secrets Are Applied To Preview As Well As Production

Reviewer claim: production secret bindings are sent to preview and production targets.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/trigger/apply-runtime-env.ts`: `const providerTargets = ["preview", "production"]`.

Reproduction method: static production-path inspection.

Observed result:

```text
SECRETS_TARGET_PREVIEW = true
```

Concrete consequence: app production secrets are exposed to preview deployments/environments for that Vercel project.

Required next node: `15R.7 Secret Environment Target Reduction`

Provider verification required? No.

Notes: this is not a plaintext leak in logs, but it broadens runtime exposure.

### P1-H - Resource Policy Enforcement Occurs After Secret Injection / Provider Mutation

Reviewer claim: a deployment that ultimately fails resource policy may already have provider mutations and secret injection.

Classification: `CONFIRMED`

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

Required next node: `15R.8 Resource Policy Ordering`

Provider verification required? No.

Notes: Node 04.17 correctly blocks missing required configuration before provisioning; this finding is about resource policy order, not env requirement verification.

### P1-I - Control-Plane Dependency Graph Is Not Reproducibly Locked

Reviewer claim: control-plane install/deploy dependencies are not frozen by a tracked lockfile.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/package.json`
- `control-plane/trigger.config.ts`

Reproduction method: repository file inventory.

Observed result:

```text
LOCKFILE_TRACKED = false
FROZEN_INSTALL_USED = false
```

Concrete consequence: Trigger/control-plane deployments can resolve dependency versions differently over time.

Required next node: `15R.9 Reproducible Control-Plane Dependencies`

Provider verification required? No.

Notes: no `control-plane/package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock` is tracked.

### P1-J - Restore Target Protection Can Allow Production-Equivalent Connection Strings

Reviewer claim: disposable restore guard compares raw connection strings and can miss equivalent source/restore targets.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/scripts/restore-control-plane-db-disposable.mjs`

Reproduction method: string-only guard inspection.

Observed result:

- The guard refuses only when `process.env.DATABASE_URL === restoreDatabaseUrl`.
- `DATABASE_URL` absent is allowed and no source/restore comparison occurs.
- Same database with benign query-string/order differences, alternate host aliases, URL encoding differences, or equivalent pooled/unpooled endpoints can pass the raw string comparison.

Concrete consequence: operator error could restore over a production-equivalent target despite the disposable confirmation phrase.

Required next node: `15R.10 Restore Target Equivalence Guard`

Provider verification required? No, though Neon endpoint equivalence may need operator/provider confirmation for robust checks.

Notes: the restore script is already confirmation-gated; this finding is about target equivalence strength.

### P1-K - Restored-Secret Decrypt Verification Calls Decrypt Helper Incorrectly

Reviewer claim: functional restore verifier uses the wrong `decryptAppSecret` call shape.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/scripts/verify-restored-control-plane-functional.mjs`
- `control-plane/src/secret-store.mjs`

Reproduction method: static signature comparison.

Observed result:

```text
decryptAppSecret signature = decryptAppSecret(db, { appId, name })
verifier call = decryptAppSecret(db, row.app_id, row.name)
DECRYPT_TEST_CALL_VALID = false
```

Concrete consequence: if the optional decrypt branch is enabled with a deterministic test secret and expected digest, it will not call the helper correctly.

Required next node: `15R.10 Restore Target Equivalence Guard`

Provider verification required? No.

Notes: Node 18 drill reported `SECRET_RECOVERY = METADATA_ONLY`, so this did not invalidate the completed metadata-only restore evidence.

### P1-L - Workspace-Level Economic / Admission Limits Are Absent Or Insufficient

Reviewer claim: one workspace can multiply per-app limits by creating many apps.

Classification: `PARTIALLY_CONFIRMED`

Exact files/functions:

- `control-plane/db/010_app_resource_policies.sql`
- `control-plane/trigger/enforce-resource-policy.ts`
- `control-plane/scripts/create-app-deployment.mjs`

Reproduction method: static schema/flow inspection.

Observed result:

| Level | Enforcement |
| --- | --- |
| Deployment | build timeout, health attempts, provider operation recovery, build log cap |
| App | max env vars, max deployments per day through `app_resource_policies` |
| Workspace | absent |
| Global | absent except provider/account limits |

Concrete consequence: under any future public entrypoint, one workspace could create many apps and multiply per-app deployment/provider usage limits.

Required next node: `15R.11 Workspace Admission / Economic Limits`

Provider verification required? No.

Notes: current founder/operator scripts reduce immediate abuse exposure, but the economic control is not present.

### P1-M - Customer PostgreSQL Provisioning Is Not Implemented In Production Lifecycle

Reviewer claim: SSC V1 advertises PostgreSQL support, but production lifecycle does not provision customer PostgreSQL.

Classification: `CONFIRMED`

Exact files/functions:

- `control-plane/db/001_initial_schema.sql`: `app_databases` placeholder table.
- `control-plane/src/project-detection.mjs`: detects database requirement from dependencies.
- `control-plane/src/deployment-state.mjs`: can route database-required analysis to `PROVISIONING`.
- `docs/03-architecture-spike/SPIKE-C-RESULTS.md`: real Neon spike proof.
- No active `control-plane/trigger/*database*` provisioning task or orchestrator customer database branch exists.

Reproduction method: repository search for customer database lifecycle create/reconcile/credential generation/app binding/delete.

Observed result:

```text
CUSTOMER_POSTGRESQL_PROVISIONING = SPIKE_ONLY
```

Concrete consequence: a workload requiring SSC-provisioned PostgreSQL cannot currently be deployed through the production control-plane lifecycle without using an existing external database/secret path.

Required next node: `15R.12 Customer PostgreSQL Lifecycle Reality`

Provider verification required? Yes before implementation, to validate current Neon API/scope/deletion/backup semantics.

Notes: this is a product-contract gap more than a hostile-code bug, but it is alpha-relevant because PostgreSQL is in SSC V1 scope.

## Final Frozen Remediation Table

| Frozen ID | Source Finding | Classification | Required Next Node | Summary |
| --- | --- | --- | --- | --- |
| `15R-F01` | P0-A | `CONFIRMED`; `RESOLVED_BY_15R_1` | `15R.1` | Slug-only Vercel project naming/adoption crosses workspaces |
| `15R-F02` | P0-B | `CONFIRMED`; `RESOLVED_BY_15R_2` | `15R.2` | Mutating operator scripts now require workspace-scoped app targeting or immutable deployment id targeting |
| `15R-F03` | Tenant-boundary assertion wiring | `PARTIALLY_CONFIRMED`; `RESOLVED_BY_15R_3` | `15R.3` | Meaningful tenant-boundary assertions are wired into controlled-alpha source, runtime, secret, build, and provider-resource paths |
| `15R-F04` | P1-A | `CONFIRMED` | `15R.2` | Concurrent build execution can double-create provider deployments |
| `15R-F05` | P1-B | `CONFIRMED` | `15R.2` | Delete/provision and abandon/build races can leave residual provider state |
| `15R-F06` | P1-C | `CONFIRMED` | `15R.3` | Timeout/abandon does not cancel provider build execution |
| `15R-F07` | P1-D | `CONFIRMED_PROVIDER_DEPENDENT` | `15R.4` | Git auto-deploy containment is not production-proven |
| `15R-F08` | P1-E | `CONFIRMED` | `15R.5` | Build can advance with missing independently observed source SHA |
| `15R-F09` | P1-F | `CONFIRMED` | `15R.6` | Public URL check proves reachability, not exact deployment identity |
| `15R-F10` | P1-G | `CONFIRMED` | `15R.7` | Production secrets are applied to preview and production targets |
| `15R-F11` | P1-H | `CONFIRMED` | `15R.8` | Resource policy runs after runtime provisioning and secret injection |
| `15R-F12` | P1-I | `CONFIRMED` | `15R.9` | Control-plane dependencies are not lockfile-pinned |
| `15R-F13` | P1-J | `CONFIRMED` | `15R.10` | Restore guard uses raw connection string equality only |
| `15R-F14` | P1-K | `CONFIRMED` | `15R.10` | Optional restored-secret decrypt branch calls helper incorrectly |
| `15R-F15` | P1-L | `PARTIALLY_CONFIRMED` | `15R.11` | Per-app policy exists, workspace/global economic limits do not |
| `15R-F16` | P1-M | `CONFIRMED` | `15R.12` | Customer PostgreSQL provisioning is spike/schema only |

No speculative remediation nodes were added beyond reproduced findings. The next node should start with the P0 class because provider project identity and slug targeting affect multiple downstream operations.

## Final Status

`P0_A_PROJECT_ADOPTION = CONFIRMED`

`P0_B_OPERATOR_TARGETING = RESOLVED_BY_15R_2`

`TENANT_ASSERTIONS_PRODUCTION_WIRING = RESOLVED_BY_15R_3`

`DUPLICATE_PROVIDER_CREATE = CONFIRMED`

`DELETE_PROVISION_RACE = CONFIRMED`

`ABANDON_BUILD_RACE = CONFIRMED`

`REMOTE_BUILD_CANCELLATION = ABSENT`

`GIT_AUTODEPLOY_CONTAINMENT = PROVIDER_DEPENDENT`

`SOURCE_IDENTITY_FAIL_OPEN = CONFIRMED`

`LIVE_IDENTITY_PROOF = PARTIAL`

`SECRETS_TARGET_PREVIEW = true`

`RESOURCE_POLICY_BEFORE_SECRET_INJECTION = false`

`LOCKFILE_TRACKED = false`

`RESTORE_PRODUCTION_EQUIVALENCE_GUARD = FAIL`

`RESTORED_SECRET_DECRYPT_CALL = INVALID`

`WORKSPACE_RESOURCE_LIMIT = ABSENT`

`CUSTOMER_POSTGRESQL_PROVISIONING = SPIKE_ONLY`

`CONFIRMED_P0_COUNT = 2`

`CONFIRMED_P1_COUNT = 11`

`PROVIDER_DEPENDENT_COUNT = 1`

`REJECTED_FINDING_COUNT = 0`

`NEXT_NODE = 15R.1 Provider Project Identity / Slug Collision`

`NODE_15R_0_COMPLETE = true`

`PRODUCTION_CODE_CHANGED = false`

`PROVIDER_STATE_MUTATED = false`

`DATABASE_STATE_MUTATED = false`

`PUSHED = false`
