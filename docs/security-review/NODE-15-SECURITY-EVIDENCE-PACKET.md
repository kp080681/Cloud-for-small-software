# Node 15 Security Review Evidence Packet

Status: preparatory evidence packet only. Node 15 is not complete.

Master graph status:

- Gate 9: PASS
- Gate 10: OPEN_DEFERRED
- Vantage technical proof: PASS
- Gate 11: BLOCKED_BY_GATE_10
- Gate 12: not complete

Authoritative source: `docs/00-master-execution-graph/MASTER-GRAPH.md`

## Scope

This packet documents the current Small Software Cloud V1 security posture for engineering hardening and future independent infrastructure/security review. It is based on repository evidence only. It does not claim external-alpha readiness.

Primary evidence inspected:

- `AGENTS.md`
- `docs/00-master-execution-graph/MASTER-GRAPH.md`
- `docs/02-v1-architecture/SECURITY-MODEL.md`
- `docs/02-v1-architecture/SECRETS-ARCHITECTURE.md`
- `docs/02-v1-architecture/SYSTEM-BOUNDARY.md`
- `control-plane/db/*.sql`
- `control-plane/src/*.mjs`
- `control-plane/trigger/*.ts`
- `control-plane/scripts/*.mjs`
- `control-plane/test/*.test.mjs`

## 1. Trust Boundaries

| Boundary | Data Crossing | Credentials Involved | Authority Granted | Compromise Impact |
| --- | --- | --- | --- | --- |
| User/operator to local scripts | app slug/id, repository, commit SHA, secret values, deployment ids | local `DATABASE_URL`, `TRIGGER_SECRET_KEY`, sometimes AWS/GitHub/Vercel env | Direct control-plane mutation through trusted operator scripts | High until a real authenticated user/API layer exists; scripts must not become public entrypoints unchanged |
| Control-plane scripts/workers to PostgreSQL | workspaces, apps, deployments, events, encrypted secret material, provider ids | `DATABASE_URL` | Read/write platform system of record | Critical if stolen; could alter state, bind secrets, delete apps |
| Trigger workers to GitHub App | repository metadata, tree/blob contents for exact commits | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, installation token | Read selected GitHub installation repositories | High; repository source disclosure and possible source pipeline compromise |
| Trigger workers to AWS KMS | encrypted data keys, encryption context | AWS identity, `AWS_KMS_KEY_ID` | Generate/decrypt data keys for app secrets | Critical when combined with DB access; KMS alone should not reveal plaintext |
| Trigger workers to Vercel | project create/delete, env injection, deployment create/status/log lookup | `VERCEL_TOKEN`, optional `VERCEL_TEAM_ID` | Mutate runtime projects, env vars, deployments | Critical; could affect all Vercel resources reachable by token scope |
| Control plane to customer workload URL | health/public GET requests | no platform credentials after 15.1; workload requests use `workload-http.mjs` safe header helpers | Read application HTTP response | Original 15.0 health-check credential leak is fixed and covered by regression tests |
| Vercel build/runtime to customer code | source commit, app env vars, build commands | intended app secrets only | Executes customer dependency/build/runtime code in Vercel isolation | Depends on provider isolation; must not receive platform credentials |
| Customer workload to external providers | app-specific API calls and database traffic | customer-provided app secrets | Application-specific access | Customer/app impact; not control-plane impact if boundaries hold |

## 2. Customer Code Isolation

Customer source is fetched and inspected by `prepare-build-input.ts` and `detect-env-requirements.ts` using GitHub App installation access and immutable commit/tree identity. The analyzer parses `package.json` and scans source text for static `process.env` references. It does not run `npm install`, package scripts, shell commands, or application code locally.

Customer code is packaged and executed by Vercel through `execute-build.ts`, which creates a provider deployment for a pinned commit using `gitSource` and stamped SSC metadata. Runtime execution is delegated to Vercel.

`CUSTOMER_CODE_EXECUTES_IN_CONTROL_PLANE = false` based on current implementation.

Resolved 15.1 caveat: the original packet found that `health-check.ts` sent `Authorization: Bearer ${VERCEL_TOKEN}` to the customer deployment URL. Customer code did not execute in the control-plane process, but hostile customer code could have read and exfiltrated the provider credential from the incoming request. The 15.1 fix routes health and public workload requests through `control-plane/src/workload-http.mjs`, which rejects credential-bearing workload headers and omits `Authorization`.

## 3. Tenant Isolation Matrix

| Object/Path | Current Evidence | Ownership Posture | Gap |
| --- | --- | --- | --- |
| Workspaces | `workspaces` table; `workspace_id` carried through core records | Data model supports tenant ownership | No public auth/membership layer in current executable code |
| Repositories | `github_repositories` scoped by `workspace_id`; `create-app-deployment.mjs` resolves repo then app by workspace | Good for operator flow | Public API must validate user membership before mapping/using repo |
| Apps | `apps.workspace_id`; scripts often resolve by slug or id | Partially scoped | Slug-only scripts are operator-only and must not be exposed |
| Deployments | `deployments.workspace_id`, `app_id`; workers commonly accept only `deploymentId` and derive app/workspace | Safe only behind trusted Trigger/operator boundary | Future user-triggered entrypoints must authorize deployment ownership before enqueue |
| Secrets | `encrypted_secrets.workspace_id/app_id`; `app_secret_bindings.workspace_id/app_id`; 15.2 same-app/same-workspace joins and assertions in runtime injection | App scoped, encrypted, application-enforced on runtime injection | No DB-level composite constraint proving `binding.secret_id` belongs to same app/workspace |
| Runtimes | `app_runtimes.workspace_id/app_id`; deterministic runtime reconciliation; 15.2 runtime/deployment assertion helper | Scoped in data model and application-enforced in runtime env path | Public deletion/provision calls need caller authorization |
| Builds/logs/health | Deployment-scoped tables | Tied to deployment ownership indirectly | Read APIs must authorize deployment ownership |
| Provider operations | `deployment_provider_operations.deployment_id` plus provider ids | Good for recovery traceability | Read/repair operations must remain operator-only until auth exists |

Potential IDOR/cross-workspace risk: many Trigger tasks accept only `deploymentId`; `delete-app.ts` accepts `appId`, `workspaceId`, and deletion key; scripts like `set-app-secret.mjs` and diagnostic/timeline runners use app slug or deployment id. This is acceptable for current trusted local/Trigger operation, but these cannot be exposed to external users without an authenticated authorization layer.

15.2 hardening added `control-plane/src/tenant-boundary.mjs` and `control-plane/test/tenant-boundary.test.mjs` to make tenant ownership assumptions executable. The tests model two synthetic workspaces with separate repositories, apps, deployments, secrets, runtimes, builds, and provider operations, and assert that cross-workspace combinations are rejected.

## 3.1 DB Constraint Matrix

| Boundary | DB Enforced | Application Enforced | Remaining Risk |
| --- | --- | --- | --- |
| Repository belongs to workspace | `github_repositories.workspace_id` and FK to installation | mapping scripts save repository under installation workspace | DB does not enforce installation workspace consistency with repository workspace beyond application logic |
| App belongs to workspace | `apps.workspace_id`; slug unique per workspace | app creation resolves repository workspace first | `apps.repository_id` can reference a repository row from another workspace if directly inserted by privileged code |
| Deployment belongs to app/workspace | `deployments.workspace_id`, `app_id` FKs | deployment creation uses app/repository workspace; workers derive app/workspace from deployment | DB does not enforce deployment workspace equals app workspace |
| Secret belongs to app/workspace | `encrypted_secrets.workspace_id`, `app_id` FKs | KMS encryption context validates workspace/app/name on decrypt | DB does not enforce secret workspace equals app workspace |
| Secret binding uses same app secret | binding and secret FKs exist separately | 15.2 runtime injection and inventory joins require `s.workspace_id=b.workspace_id` and `s.app_id=b.app_id`; assertions validate before decrypt/inject | DB can still store an invalid foreign binding row, but current runtime injection will not use it |
| Runtime belongs to app/workspace | `app_runtimes.workspace_id`, `app_id` FKs | provisioning derives runtime from deployment app; 15.2 assertion validates runtime/deployment match in env injection | DB does not enforce runtime workspace equals app workspace |
| Build belongs to deployment | `deployment_builds.deployment_id` FK and provider id unique | build creation/recovery uses deployment id and source commit; 15.2 assertions cover cross-deployment build misuse | DB does not duplicate workspace id for direct constraint |
| Provider operation belongs to deployment | `deployment_provider_operations.deployment_id` FK and unique operation key | operation key includes deployment/source; recovery matches SSC metadata | DB does not independently encode workspace |

Smallest future DB-hardening migration, if approved later: add composite uniqueness/FK patterns or constraint triggers so child rows carrying both `workspace_id` and parent ids must match the parent row workspace/app. This was not added in 15.2.

## 4. Secret Lifecycle

Plaintext input enters through operator scripts such as `store-app-secret.mjs`, `set-app-secret.mjs`, and `import-env-file.mjs`.

Storage path:

1. `encryptAppSecret` generates a KMS data key.
2. The secret is encrypted locally with AES-256-GCM.
3. The encrypted data key, ciphertext, IV, auth tag, KMS key id, and encryption context are persisted in `encrypted_secrets`.
4. Decryption validates namespace/workspace/app/secret context before using KMS.
5. Runtime injection in `apply-runtime-env.ts` decrypts only app-bound production bindings and sends them to Vercel as sensitive environment variables.
6. `deployment_secret_applications` records which binding/version was applied, without plaintext.
7. App deletion removes `app_secret_bindings`, `app_runtimes`, and `encrypted_secrets`.

Strong controls:

- KMS-backed envelope encryption exists.
- Encryption context binds namespace, workspace, app, and secret name.
- Build-log ingestion redacts known secret values, encoded variants, database URLs, and bearer authorization patterns.
- Diagnostics and timeline redaction strip secret/token/credential/providerBody/rawLog/value fields.

Gaps:

- `set-app-secret.mjs` prints a SHA-256 digest of the plaintext secret. This is not plaintext, but it is unnecessary sensitive metadata and should be removed before broader use.
- `import-env-file.mjs` attempts to clear `raw` with `raw.replace`, but strings are immutable; this is only best-effort and not a real memory wipe.
- Secret values are applied to both `preview` and `production` provider targets. That may be acceptable for current V1 direct-production deployment, but should be reviewed against least-exposure goals.
- 15.2 tests now prove runtime injection rejects wrong-tenant secret bindings at the application layer, and the runtime/inventory queries only join secrets whose `workspace_id` and `app_id` match the binding. A DB-level constraint is still not present.

## 5. Credential Scope Matrix

| Credential | Purpose | Current Known Scope | Minimum Required Scope | Scope Verified | Risk If Compromised |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Control-plane PostgreSQL access | Unknown from repo | Least-privileged app role for control-plane schema only | UNKNOWN | Full control-plane state compromise |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | Mint installation tokens for source reads | GitHub App, exact permissions not recorded in repo | Read-only contents/metadata for selected installations | NO | Repository source disclosure, source identity tampering if over-scoped |
| GitHub installation token | Read repository commit/tree/blob contents | Minted per installation | Read-only contents and metadata | NO | Source disclosure within installation scope |
| `VERCEL_TOKEN` | Project/env/deployment/log/delete operations | Unknown token breadth | Minimal Vercel team/project permissions needed for SSC-owned projects only | NO | Runtime/provider compromise across reachable projects |
| `AWS_KMS_KEY_ID` + AWS identity | Generate/decrypt data keys | Unknown IAM policy | KMS key use limited by encryption context and worker identity | NO | Secret decryption when combined with DB/ciphertext |
| `TRIGGER_SECRET_KEY` | Trigger task submission from runner scripts | Unknown | Trigger only required SSC tasks/environments | NO | Unauthorized task execution |
| Neon/control-plane DB provider credentials | Database hosting/admin | Not represented in repo | Operational admin outside app runtime | UNKNOWN | DB availability/data compromise |

## 5.1 Provider Credential Least-Privilege Review

15.3 audit result: no new code-level path was found that sends platform/provider credentials to customer workload URLs. Provider credentials are used for fixed provider APIs or local/Trigger control-plane operations. Provider-side credential scopes are not fully provable from repository code, so those settings remain `VERIFY_PROVIDER_SETTING` until checked in GitHub, Vercel, AWS, Trigger.dev, and the control-plane database provider.

### GitHub App

Current code mints GitHub App installation tokens through `createAppAuth` and uses read-oriented API calls:

- `apps.getInstallation` and `apps.listReposAccessibleToInstallation` in `sync-github-installation.mjs`
- `repos.get` and `git.getRef` in `map-github-repository.mjs` and `inspect-repository.mjs`
- `git.getCommit` and `repos.getContent` in `prepare-build-input.ts`
- `git.getTree` and `git.getBlob` in `detect-env-requirements.ts`
- `git.getRef` in `create-redeployment.ts`

Repository write access is not required by current SSC code. The minimum practical GitHub App permission set is metadata plus read-only contents for selected installations/repositories. Webhook permissions/settings, if used outside this repo snapshot, should be verified separately. Current app-side permission settings are `VERIFY_PROVIDER_SETTING`.

`GITHUB_REPOSITORY_WRITE_REQUIRED = false`.

### Vercel

Current Vercel API usage is provider-control-plane traffic, not customer workload traffic:

| Endpoint/Method | Code Path | Purpose | Destructive |
| --- | --- | --- | --- |
| `GET /v9/projects/{id-or-name}` | `provision-runtime.ts`, `configure-public-access.ts`, `create-disposable-orphan-fixture.mjs` | Runtime/project lookup and reconciliation | No |
| `POST /v11/projects` | `provision-runtime.ts` | Create SSC-managed Vercel project while avoiding project-level Git linkage where possible | Creates provider resource |
| `POST /v10/projects/{project}/env?upsert=true` | `apply-runtime-env.ts` | Apply app-scoped runtime environment variables | Mutates provider env |
| `GET /v7/deployments` | `execute-build.ts`, `detect-orphan-resources.ts`, `create-disposable-orphan-fixture.mjs` | Deployment recovery/orphan inventory | No |
| `GET /v13/deployments/{id}` | `execute-build.ts`, `reconcile-build.ts`, `configure-public-access.ts`, `detect-orphan-resources.ts`, `create-disposable-orphan-fixture.mjs` | Provider deployment status/source/public URL evidence | No |
| `POST /v13/deployments` | `execute-build.ts`, `create-disposable-orphan-fixture.mjs` | Create SSC deployment or disposable orphan fixture | Creates provider deployment |
| `GET /v3/deployments/{id}/events` | `ingest-build-logs.ts` | Build log/event ingestion | No |
| `DELETE /v9/projects/{projectId}` | `delete-app.ts` | Delete SSC-owned runtime project | Destructive |

The minimum practical Vercel authority is scoped to the SSC Vercel team/projects and allows project lookup/create/delete, deployment list/read/create/log read, and environment writes for SSC-owned projects. The repository cannot prove the actual token is project/team-limited rather than broad account-level, so the setting remains `VERIFY_PROVIDER_SETTING` and should be reduced before external alpha if broad.

### AWS KMS

`secret-store.mjs` uses only `GenerateDataKeyCommand` and `DecryptCommand` with a stable encryption context containing the SSC namespace, workspace id, app id, and secret name. No code path uses KMS admin APIs such as key creation, deletion scheduling, policy mutation, or grant management.

Runtime workers do not require KMS admin permissions. Minimum IAM is `kms:GenerateDataKey` and `kms:Decrypt` on the configured key, preferably constrained to the SSC worker identity and encryption context. Actual IAM policy is `VERIFY_PROVIDER_SETTING`.

`KMS_RUNTIME_ADMIN_PERMISSION_REQUIRED = false`.

### Trigger.dev

`TRIGGER_SECRET_KEY` is used by local runner scripts to enqueue existing Trigger tasks. Trigger workers call each other through `tasks.triggerAndWait`, and `deploy:trigger` uses the Trigger CLI. No workload HTTP request or Vercel app environment path receives the Trigger credential in current code.

The blast radius of a leaked Trigger submission credential is unauthorized execution of reachable control-plane tasks, including high-impact tasks such as deploy/delete runners if the environment permits them. Task/environment scoping is `VERIFY_PROVIDER_SETTING`.

### Control-Plane PostgreSQL

`DATABASE_URL` is used by workers and local scripts for the control-plane system of record. The same repository also includes `apply-migration.mjs`, so the repo cannot prove whether production runtime workers use a DML-only role while migrations use a separate DDL-capable role.

The control-plane database credential is not exposed to customer workloads in current code. Before external alpha, verify or separate database roles so regular Trigger workers cannot perform schema-owner operations such as `DROP`/`ALTER` if that is not already true.

### Neon / Customer PostgreSQL

Current active control-plane code does not contain a Neon provisioning token path. Architecture/spike docs identify Neon as the preferred managed PostgreSQL direction and show customer `DATABASE_URL` injection as an app secret. Customer database credentials are workload credentials, not provider/admin credentials, and should remain stored through the encrypted secret path.

No Neon provider/admin credential exposure to customer workloads was found in current code. If Neon provisioning is reintroduced, its provider credential must stay in the control-plane environment only and be scoped to SSC-managed customer database resources.

### Credential Storage And Longevity

| Credential Family | Current Storage Pattern | Lifetime/Exposure Notes |
| --- | --- | --- |
| GitHub App private key | Local/Trigger control-plane environment | Long-lived app credential; installation tokens are minted per installation and should remain short-lived |
| Vercel token | Local/Trigger control-plane environment | Long-lived mutation credential unless provider setting says otherwise; provider scope must be verified |
| AWS KMS worker identity | Local/Trigger environment/provider identity | Should be limited to data-key generation and decrypt on the SSC key |
| Trigger submission credential | Local operator environment for runner scripts | Must not be embedded in workloads or public clients |
| Control-plane `DATABASE_URL` | Local/Trigger control-plane environment | Critical system-of-record credential; separate runtime and migration privileges if not already separated |
| Customer app secrets | `encrypted_secrets` plus KMS envelope encryption; Vercel sensitive env after injection | App-scoped workload credentials; plaintext should remain transient |
| Customer database URLs | Encrypted app secret and provider workload env | Workload-scoped data credential, not a platform/provider admin token |

### Code-Level Enforcement Evidence

- GitHub access uses installation tokens rather than broad personal access tokens.
- Immutable source identity and deployment build inputs prevent local filesystem source substitution.
- 15.1 `workload-http.mjs` prevents workload HTTP requests from carrying platform credentials and protects redirect paths from forwarding `Authorization`.
- 15.2 `tenant-boundary.mjs` and runtime-env joins prevent cross-workspace/app secret injection.
- KMS encryption context binds secret decrypt operations to namespace/workspace/app/secret identity.
- Provider operation ledger and Vercel SSC metadata constrain deployment recovery to deterministic SSC identity.
- Vercel Git auto-deploy containment now requires disconnected project Git linkage; connected or unknown provider Git state fails closed before runtime attachment, secret injection, or build creation.

## 6. Build Isolation

Customer build commands are inferred from `package.json` but are not executed by SSC. `prepare-build-input.ts` records commands such as `npm ci` and `npm run build`; `execute-build.ts` passes them to Vercel project/deployment settings. This keeps malicious lifecycle scripts out of the control-plane process and Trigger worker runtime.

Current controls:

- Immutable commit SHA and Git tree SHA are recorded.
- `package.json` must exist under configured root.
- Source identity mismatch during provider reconciliation fails the deployment.
- Vercel deployments include deterministic SSC metadata for recovery.
- Vercel Git auto-deployment containment requires project Git linkage to be absent/disconnected so SSC remains lifecycle owner.

Remaining risks:

- Install/build command values originate from package manager/script names rather than arbitrary shell input, but provider build still runs arbitrary customer code in Vercel as intended.
- Provider isolation model for hostile external repositories still needs specialist validation.

## 7. Path / Source Safety

Existing defenses:

- Source comes from GitHub APIs at immutable commit/tree identity, not the local filesystem.
- Environment detector rejects source files larger than 512 KiB and enforces total scanned byte/file/path limits.
- GitHub truncated recursive trees cause detection failure rather than incomplete silent success.
- Detector scans only selected JS/TS/Next source file types and stores bounded source references.
- 15.4 `source-boundary.mjs` validates repository-relative paths and root directories before source inspection or provider root configuration.

Remaining gaps:

- `apply-migration.mjs` reads an env-provided filesystem path and is an operator-only tool; it must never be externally exposed.

## 8. Network / SSRF

Provider API calls use fixed Vercel/GitHub endpoints with encoded path parameters. Public verification builds its URL from Vercel project/deployment data and performs an anonymous HTTPS GET with manual redirects.

Health verification requires HTTPS and uses `provider_deployment_url` from control-plane/provider state. After 15.1 it does not include platform credentials, so redirects cannot forward platform credentials from the health request. After 15.4, redirects are followed manually only after target validation.

Original SSRF classification: MEDIUM residual risk for health-check URL validation and redirect policy; original CRITICAL credential-disclosure risk from the health-check authorization header was resolved by 15.1.

15.4 update: workload health/public HTTP behavior now validates the initial workload URL and every followed redirect through `workload-http.mjs`. Current V1 workload URLs must use HTTPS, target the expected Vercel workload domain, and must not target localhost, loopback, private IPv4 ranges, link-local ranges, the `169.254.169.254` metadata endpoint, `metadata.google.internal`, or blocked IPv6 local/link-local patterns. Health checks now perform manual bounded redirect following instead of `fetch` automatic redirects. Public-access verification already used manual redirects; it now marks unsafe redirect targets as not publicly reachable rather than following them.

Updated SSRF classification: `ALREADY_CONTROLLED` for localhost/private/link-local/metadata redirects in current Vercel-backed workload verification. Residual `ACCEPTABLE_V1_RISK`: hostname resolution is not independently DNS-resolved before fetch, so the current control relies on V1's expected `*.vercel.app` hostname boundary rather than a generic outbound network sandbox.

## 8.1 Hostile Source / Path Boundary

15.4 audit traced source ingestion:

- GitHub archive extraction is not used by the active control-plane deployment path.
- Customer repository files are not written to local disk by source inspection.
- Customer code and package scripts are not executed locally.
- `prepare-build-input.ts` reads repository root metadata and `package.json` through GitHub APIs at the immutable deployment commit.
- `detect-env-requirements.ts` reads the immutable Git tree and selected blob contents through GitHub APIs.
- Symlink entries, if represented by GitHub as blob content, are not followed through the local filesystem because SSC never resolves repository paths against a local checkout during analysis.

`source-boundary.mjs` adds a canonical repository-relative path boundary for the active V1 source path. It rejects traversal segments, backslash traversal, absolute POSIX paths, Windows drive paths, UNC paths, malformed/encoded traversal, NUL bytes, excessive path length, and duplicate normalized paths. It normalizes accepted roots such as `.`, `apps/web`, and `packages/frontend` while rejecting roots that escape the repository.

Current source-analysis limits:

| Limit | Value | Enforcement |
| --- | --- | --- |
| Repository tree entries | 5000 | `assertUniqueRepositoryPaths` |
| Detectable source files | 500 | `assertDetectableSourceFileCount` |
| Total source bytes scanned | 5 MiB | `assertTotalSourceBytes` |
| Single source file bytes | 512 KiB | `assertSingleSourceFileSize` |
| Repository path length | 240 chars | `normalizeRepositoryRelativePath` |

Oversized or unsafe source now fails deterministically with source-boundary error codes instead of partially continuing with ambiguous evidence. The environment detector still limits scanning to JS/TS/Next source filenames and ignores generated/dependency directories such as `node_modules`, `.next`, `.git`, `dist`, `build`, `coverage`, and `out`.

15.4 tests cover traversal roots, absolute roots, Windows/UNC roots, encoded traversal, excessive files, excessive bytes, oversized files, long paths, duplicate normalized paths, binary-like content, localhost/private/metadata workload URLs, unsafe redirects, and redirect loops.

## 9. Resource / Abuse Controls

| Control | Current Status | Evidence |
| --- | --- | --- |
| Deployment count per day | APPLICATION_POLICY | `app_resource_policies.max_deployments_per_day`, `enforce-resource-policy.ts` |
| Health attempts | APPLICATION_POLICY | `max_health_attempts`, `health-check.ts`, recovery tests |
| Build timeout | APPLICATION_POLICY | `max_build_minutes`, orchestrator timeout handling |
| Environment variable count | APPLICATION_POLICY | `max_env_vars`, `enforce-resource-policy.ts` |
| Build log volume | APPLICATION_POLICY | `max_log_events` schema plus `ingest-build-logs.ts` max 200 events |
| Trigger retries | APPLICATION_POLICY | task retry settings on workers |
| Runtime CPU/memory/storage | PROVIDER_ENFORCED | Delegated to Vercel; exact limits not verified in repo |
| Source analysis size | APPLICATION_POLICY | 15.4 source file count, total byte, per-file byte, and path-length limits |
| Provider build size/runtime limits | PROVIDER_ENFORCED | Delegated to Vercel; exact limits not verified in repo |
| Concurrent operations | NOT_ENFORCED | No explicit per-workspace concurrency limiter found |
| Public API rate limits | NOT_ENFORCED | No external public API layer present yet |
| Suspension | NOT_ENFORCED | Delete/abandon exist; non-destructive suspend does not |

## 10. Logging / Information Disclosure

Strong controls:

- Build logs are bounded and redacted before storage.
- Diagnostics avoid returning raw logs and provider bodies.
- Timeline evidence allowlists safe fields and strips secret/token/credential/private/provider/raw/value fields.
- Env detection records variable names and source references, not values.
- Provider-operation and deployment events record ids/statuses rather than response dumps.

Risks:

- Historical 15.0 finding: health-check `Authorization` header exposed `VERCEL_TOKEN` to customer workload. Status: RESOLVED in 15.1 by removing credential-bearing headers from workload requests and adding regression tests in `control-plane/test/workload-http.test.mjs`.
- Some provider error messages are stored in `error_message`; diagnostics intentionally do not expose raw `error_message`, but operator logs/Trigger output need review before external alpha.
- Secret digest output in `set-app-secret.mjs` is avoidable sensitive metadata.
- Local scripts depend on operator discipline not to run with verbose shell/history capture of secret env values.

## 11. Deletion

Deletion flow:

1. `run-delete-app.mjs` triggers `delete-app.ts` with app/workspace/deletion key.
2. `delete-app.ts` records/reuses `app_deletions`.
3. Deployment rows are marked `DELETING`.
4. Vercel project deletion treats 204/404/410 as successful provider deletion.
5. In one transaction, runtime bindings and encrypted secrets are deleted, deployments become `DELETED`, the app is soft-deleted, and deletion status becomes `COMPLETED`.

Controls:

- Idempotent deletion request keyed by app.
- Workspace id is checked on task input.
- Provider project identity is frozen into `app_deletions`.
- Historical non-secret control-plane records are preserved.

Gaps:

- No non-destructive emergency suspension path.
- Deletion is intentionally destructive for runtime/secrets; recovery boundaries need operator documentation.
- A cross-app provider project id bug would be dangerous; current deterministic runtime ownership and orphan detection reduce but do not fully eliminate this class.

## 12. External Entrypoints

Current repository mainly exposes founder/operator scripts and Trigger tasks, not a hardened customer-facing API. An eventual external alpha user could cause SSC to:

- connect/select a GitHub repository
- create/update app records
- set secrets
- request deploy/redeploy
- request diagnostics/timeline/logs
- request app deletion

Before any of those become public entrypoints, required controls are:

- authenticated user identity
- workspace membership/role authorization
- app/repository/deployment/secret ownership validation
- rate limits by user/workspace/action
- size and format validation
- explicit confirmation for destructive operations
- audit events for high-impact actions

The current operator scripts should be treated as administrative tools, not public API implementations.

## 13. Threat Register

| Severity | Threat | Attacker | Precondition | Impact | Current Control | Residual Risk | Recommended Minimum Fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RESOLVED | 15.0 health check leaked Vercel bearer token to hostile workload | Malicious customer repo | External workload deployed and health checked | Provider credential compromise | 15.1 removed `Authorization` from health workload requests; `workload-http.test.mjs` proves health/public workload requests omit credentials and reject credential-bearing workload headers | Residual risk reduced to regression risk | Keep regression tests required for health/public verification changes |
| HIGH | Cross-tenant action by guessed deployment/app/secret id if internal task exposed | External user | Public entrypoint forwards ids without authz | Cross-tenant read/write/delete | Data model has workspace ids; 15.2 added ownership assertions and cross-workspace tests for core resource combinations | High until API layer exists | Add authz facade before exposing scripts/tasks |
| HIGH | Over-scoped Vercel token mutates non-SSC projects | Attacker with token or code path bug | Token compromise or wrong project id | Broad provider damage | Deterministic runtime ids; delete identity checks | High | Verify/create least-privilege Vercel token/project scope |
| HARDENED | Cross-app secret binding through privileged bug | Malicious/buggy operator path | Binding created to another app's `secret_id` | Secret exposure to wrong app | 15.2 same-app/same-workspace joins and assertions prevent runtime injection from using the foreign secret; tests cover invalid binding and injection attempts | Residual DB-integrity risk | Add DB constraint/trigger later if external entrypoint or additional write paths require defense in depth |
| HIGH | Source scan resource exhaustion | Malicious repo | Large many-file repo under GitHub tree limit | Worker cost/delay | Per-file 512 KiB limit and truncated-tree fail closed | Medium | Add cumulative file/byte/time caps |
| HIGH | Provider build/runtime isolation insufficient for hostile code | Malicious repo | Vercel isolation not reviewed for arbitrary untrusted customers | Credential/network/resource abuse | Delegated provider isolation | Unknown | Specialist review of Vercel build/runtime isolation and env exposure |
| RESOLVED | Health/public checker SSRF via provider URL/redirect behavior | Malicious/bad provider metadata | Control-plane stores or follows unsafe URL | Internal probing | 15.4 validates Vercel workload host, blocks localhost/private/link-local/metadata targets, and follows health redirects manually with a bounded redirect count | Low V1 residual DNS-rebinding risk within trusted provider hostname boundary | Keep workload URL helper mandatory for every customer URL request |
| RESOLVED | Malicious rootDirectory/path traversal escapes repository source boundary | Malicious customer app config | `root_directory` or Git tree path contains traversal/absolute path | Wrong source inspected or provider configured outside intended repo root | 15.4 canonical repository-relative path helper rejects traversal, absolute, UNC, drive, NUL, encoded traversal, long paths, and duplicate normalized paths | Low | Keep helper at every repository-relative input seam |
| RESOLVED | Source scan resource exhaustion through many/small files or huge files | Malicious repository | Analyzer scans unbounded Git tree/blobs | Worker memory/time exhaustion or partial ambiguous scan | 15.4 file count, source file count, total byte, single-file byte, and path-length limits | Medium for provider build limits, delegated to Vercel | Add provider build-size policy later only if real workloads need it |
| MEDIUM | No non-destructive suspension | Abusive customer workload | Abuse detected before deletion decision | Slow containment or destructive-only response | Delete and abandon exist | Medium | Add operator suspend/disable path before external alpha |
| MEDIUM | Provider/API error text may expose sensitive data in operator surfaces | Provider/application failure | Error propagated to Trigger/local output | Info disclosure | Diagnostics redact and avoid raw provider bodies | Medium | Review/logging policy for all stored/printed error messages |
| MEDIUM | Secret digest printed by set-app-secret | Insider/log collector | Operator uses script with sensitive value | Offline comparison for low-entropy secrets | Plaintext not printed | Medium | Stop printing digest |
| MEDIUM | No public API rate limiting yet | External user | Customer API added without limiter | Cost/abuse exposure | Resource policy in worker | Medium | Add rate limits before exposing customer actions |
| RESOLVED | Root directory traversal/absolute path inconsistencies | Malicious configuration | Public config accepts root directory | Wrong source/provider path | 15.4 central strict repository-relative path and root-directory validator | Low | Keep source-boundary tests required for source/provider root changes |
| LOW | Immutable string clearing is ineffective | Local process/memory attacker | Process memory inspected | Secret remnants in memory | Short-lived scripts/workers | Low | Avoid claims of memory wiping; keep lifetime short |
| LOW | Orphan fixture script creates intentional unmanaged deployment if run | Operator error | Guarded script run against disposable project | Provider clutter/cost | Hard-coded disposable guard | Low | Keep script operator-only; document no cleanup in node |
| LOW | Runtime logs not fully ingested | Operator/customer | Runtime failure after deploy | Reduced visibility | Health diagnostics and provider ids | Low | Define V1 provider-log access boundary |

## 14. Security Blockers

ALPHA_BLOCKER:

- No remaining code-level alpha blocker was found in the current founder/operator deployment path after 15.1-15.4.
- Public/customer entrypoints do not yet exist as hardened authenticated/authorized APIs; current scripts/tasks must not be exposed as-is.
- Specialist review of provider build/runtime isolation and credential scopes is still required by the master graph/security model before Node 15 can be complete.

HARDEN_BEFORE_BETA:

- Add DB constraints or triggers so child-row workspace/app fields must match parent resources.
- Add non-destructive suspension.
- Remove secret digest output from `set-app-secret.mjs`.
- Document deletion/recovery boundaries and incident procedure.

ACCEPTABLE_V1_RISK:

- Provider-owned low-level build/runtime isolation, assuming specialist review accepts the provider primitive.
- Runtime log visibility limited to health diagnostics and provider traceability for V1.
- Operator scripts remain local/admin-only during founder-operated alpha preparation.

ALREADY_CONTROLLED:

- Customer source analysis does not execute repository code.
- Immutable source/build identity and replay-safe provider operation ledger exist.
- Build logs, diagnostics, and timeline avoid raw secret/provider-body exposure.
- App deletion is idempotent and audited.
- Orphan detection exists and is read-only.
- 15.2 ownership assertions and tests cover cross-workspace app, repository, deployment, secret binding, runtime, build, and provider-operation combinations.
- 15.4 hostile source/path/resource-exhaustion and workload SSRF/redirect tests pass.

## 14.1 15.5 Finding Closure Matrix

| Finding | Current Status | Evidence | Additional Work Before V1 |
| --- | --- | --- | --- |
| 15.0 health check leaked Vercel bearer token to workload | RESOLVED | 15.1 `workload-http.mjs`, `health-check.ts`, `configure-public-access.ts`, `workload-http.test.mjs` | Keep regression tests mandatory for workload HTTP changes |
| Customer source could execute inside control plane | RESOLVED | Source inspection uses GitHub APIs and parses text/JSON only; no local install/build execution | Specialist review of Vercel provider isolation remains separate |
| Cross-tenant action if internal task ids are exposed | MITIGATED | 15.2 `tenant-boundary.mjs` assertions and tests; current scripts/tasks are operator-only | Authenticated authorization facade before any public/customer entrypoint |
| Cross-app secret binding through privileged bug | MITIGATED | 15.2 same-app/same-workspace joins and runtime assertions | Optional DB-level composite constraints before broader write surfaces |
| Over-scoped Vercel token | VERIFY_PROVIDER_SETTING | 15.3 endpoint inventory defines minimum required provider authority | Verify/reduce Vercel token/team/project scope |
| GitHub App over-permissioned repository access | VERIFY_PROVIDER_SETTING | 15.3 inventory shows no repository write API usage | Verify GitHub App read-only contents/metadata/webhook settings and installation scope |
| KMS runtime/admin permission breadth | VERIFY_PROVIDER_SETTING | `secret-store.mjs` uses only GenerateDataKey and Decrypt | Verify IAM denies KMS admin actions and constrains key/context where feasible |
| Trigger credential blast radius | VERIFY_PROVIDER_SETTING | Runner scripts use `TRIGGER_SECRET_KEY`; no workload exposure found | Verify environment/task invocation scope |
| Control-plane DB role can perform schema-owner operations | VERIFY_PROVIDER_SETTING | Repo uses `DATABASE_URL` for workers and `apply-migration.mjs`; role split not provable from repo | Verify or separate runtime DML role from migration/schema owner if practical before alpha |
| Source path traversal/root escape | RESOLVED | 15.4 `source-boundary.mjs`, source-boundary tests, build-input/env/provision-runtime wiring | Keep helper required at repository-relative input seams |
| Symlink escape during source inspection | MITIGATED | No local archive extraction or filesystem path resolution; GitHub blobs are read by SHA | Specialist review can confirm GitHub symlink object handling is acceptable for V1 |
| Source scan resource exhaustion | RESOLVED | 15.4 file count, source count, total bytes, per-file, path-length limits and tests | Provider build resource limits remain provider-side verification |
| SSRF to localhost/private/metadata endpoint | RESOLVED | 15.4 workload URL/redirect validator and mocked redirect tests | Residual DNS rebinding concern is acceptable under V1 Vercel hostname boundary pending specialist review |
| Provider/API error text leakage | MITIGATED | Diagnostics/timeline redaction avoids raw provider bodies and error_message exposure | Review Trigger/operator logs before public support surfaces |
| Secret digest printed by `set-app-secret.mjs` | HARDEN_BEFORE_BETA | Digest is not plaintext but is unnecessary sensitive metadata | Remove digest output before broad operator/customer use |
| No public API rate limiting | ACCEPTABLE_V1_RISK | No public customer API layer exists yet; worker resource policies exist | Add rate limits before exposing customer actions |
| No non-destructive suspension | HARDEN_BEFORE_BETA | Delete and abandon exist; no suspend path | Add smallest operator disable/suspend path when abuse operations begin |
| Immutable string clearing is ineffective | ACCEPTABLE_V1_RISK | Short-lived scripts/workers; no claim of reliable memory wipe | Avoid documenting string clearing as a security control |
| Orphan fixture can create intentional unmanaged deployment | ACCEPTABLE_V1_RISK | Hard-coded disposable project guard and operator-only script | Keep operator-only; no automatic cleanup in 04.19 |
| Runtime logs not fully ingested | ACCEPTABLE_V1_RISK | Build logs, health, diagnostics, timeline exist; runtime provider logs not fully surfaced | Define V1 provider-log support boundary when operations need it |

## 14.2 Provider-Side Verification Checklist

GitHub App:

- Confirm repository contents permission is read-only.
- Confirm metadata access is the only broad default permission.
- Confirm webhook permissions are limited to events SSC actually consumes.
- Confirm installations are restricted to selected repositories/workspaces.
- Confirm no repository write, actions write, secrets write, administration, or deploy-key authority is granted.

Vercel:

- Confirm `VERCEL_TOKEN` is scoped to the SSC team/context used by `VERCEL_TEAM_ID`.
- Confirm it can perform only the V1-required actions: project lookup/create/delete for SSC-owned projects, deployment list/read/create, deployment log read, and environment variable upsert on SSC-owned projects.
- Confirm it cannot mutate unrelated personal/team projects outside SSC ownership.
- Confirm provider-created Git connections have automatic deployments disabled for SSC-managed projects.
- If Vercel cannot provide fine-grained project-level token scope, document the temporary founder-operated risk and operating controls before alpha.

AWS KMS:

- Confirm the runtime worker identity allows `kms:GenerateDataKey` and `kms:Decrypt` only on the SSC key.
- Confirm no key admin actions are granted to runtime workers.
- Add encryption-context conditions for SSC namespace/workspace/app/secret context where practical.
- Confirm key admins are separate from runtime/deployment workers.

Trigger.dev:

- Confirm `TRIGGER_SECRET_KEY` or equivalent task-submission credential is environment-scoped.
- Confirm production tasks cannot be invoked from untrusted clients or customer workloads.
- Confirm task secrets are not exposed to Vercel/customer runtime env.
- Confirm deployment/delete task invocation requires trusted operator/API authorization.

Control-plane PostgreSQL:

- Confirm whether runtime workers use a DML-only role.
- Confirm migrations use a separate schema-owner role.
- Confirm runtime role cannot `DROP`, `ALTER`, create unsafe extensions, or bypass expected ownership controls if separation is practical before alpha.
- Confirm backups/restores preserve encrypted secret material and KMS decryptability.

Neon/provider credentials, if retained or reintroduced:

- Confirm provider/admin token is control-plane only and never injected into workloads.
- Confirm customer databases/projects are isolated per app/workspace.
- Confirm deletion/recovery boundaries for customer database resources.

## 14.3 Code-Level Alpha Blocker Check

| Area | Status | Evidence |
| --- | --- | --- |
| Customer code isolation | PASS | Source inspection reads GitHub content and JSON/text only; customer build runs on Vercel |
| Workload credential exposure | PASS | 15.1 safe workload headers and tests |
| Tenant isolation | PASS for current operator flow | 15.2 ownership assertions/tests; public authz layer still not implemented |
| Secret binding/injection | PASS | Same-app/same-workspace joins and KMS context validation |
| Provider resource attachment | PASS | Provider operation ledger, SSC metadata, source identity checks |
| Source path traversal | PASS | 15.4 source-boundary helper/tests |
| Symlink handling | PASS for active GitHub API path | No local archive extraction or filesystem symlink following |
| Source resource exhaustion | PASS | 15.4 bounded file/path/byte limits |
| SSRF | PASS for current Vercel workload verification | Initial URL and redirect target validation |
| Workload redirects | PASS | Manual bounded health redirects; public-access redirect validation |
| Diagnostics/log leakage | PASS | Redaction tests and no raw body storage for workload checks |
| Deletion | PASS for current operator flow | Idempotent delete with workspace/deletion key and provider cleanup |

`CODE_LEVEL_ALPHA_BLOCKERS_REMAINING = 0`.

## 14.4 Node 15 Decision

`NODE_15_CODE_HARDENING = PASS`

`NODE_15_PROVIDER_SCOPE_VERIFICATION = PASS_WITH_DOCUMENTED_LIMITATIONS`

`NODE_15_SPECIALIST_REVIEW = REQUIRED`

`NODE_15_READY_FOR_SPECIALIST_REVIEW = true`

## 14.5 Node 15R.13 Provider Configuration Verification

Node 15R.13 records live provider configuration evidence from GitHub, Vercel, AWS IAM/KMS, Trigger.dev, Neon, existing 15R remediation tests, and the 15R.12B disposable Neon recovery drill. No production provider configuration, provider resources, databases, migrations, workloads, or Trigger deployments were changed while recording this evidence.

Provider status:

| Provider area | Status | Evidence |
| --- | --- | --- |
| GitHub App | PASS | Installation has read access to code and metadata, no observed write/admin permissions, and selected-repository scope only for `kp080681/dealupwebsite`, `kp080681/Vantage`, and `kp080681/Cloud-for-small-software`. |
| Vercel project identity | PASS | Live SSC project bindings for `ssc-dealup-website` and `ssc-vantage` match the expected project ids, GitHub repositories, and `main` production branch. |
| Vercel credential least privilege | PARTIAL | Current token is user-scoped for team `team_HxUKmwKrgjW0tCYyVUtYmBsA`; acceptable for founder-operated controlled alpha with SSC controls, not the final self-service credential model. |
| Vercel Git auto-deploy live behavior | PASS_DISCONNECTED_NO_AUTODEPLOY_OBSERVED | Live disposable verification showed connected projects can report `git=null` with `link` present, and `PATCH /v9/projects/{id}` with `git.deploymentEnabled=false` returns HTTP 400 through SSC's REST path. 15R.6 now treats only disconnected linkage as safe and fails closed for connected or unknown state. After manually disconnecting only the disposable `ssc-ssc-recovery-test` project, Vercel returned `git:null` and `link:null`; a harmless Git push to `kp080681/ssc-lifecycle-test` created zero out-of-band deployments. |
| Vercel environment isolation | PASS_VISUAL | Project env review found per-project grouping and no observed team-wide inheritance of SSC control-plane credentials into workload projects. |
| Vercel spend containment | PLAN_LIMITED_ACCEPTED | Hobby plan; paid on-demand usage not enabled; spend management is unavailable on the current plan. |
| AWS IAM/KMS | PASS | Runtime IAM policy allows `kms:GenerateDataKey` and `kms:Decrypt` on one specific SSC KMS key with no observed wildcard resource or runtime admin actions. |
| Trigger.dev environment | PASS | Production runtime environment contains expected control-plane credentials, no observed customer workload secrets, no observed root API key, and `NEON_API_KEY` is absent. |
| Trigger.dev credential least privilege | PARTIAL_ROOT_KEY | Root and project keys exist with unrestricted access; root credential remains operator-only and must not become a runtime dependency. |
| Trigger.dev resource ceiling | PASS | Free plan supplies a concrete ceiling: $5/month free credits, 20 concurrent runs, 10 schedules, and 1 day log retention. |
| Neon credential least privilege | PARTIAL_ORG_WIDE | Neon API key is organization-wide/admin-level; acceptable for founder-operated controlled alpha with SSC ownership/recovery controls, not ideal for public self-service. |
| Neon resource ceiling | PASS | Free plan has no paid usage enabled and includes bounded per-project storage/compute/branch limits. |
| Neon recovery | PASS | 15R.12B restored a disposable SSC-managed Neon PostgreSQL database to a captured LSN with exact row-count and digest parity and cleaned up the resource. |

Controlled-alpha economic operating boundary:

```text
CONTROLLED_ALPHA_INFRA_BUDGET_USD = 100
PROVIDER_PREEMPTIVE_UPGRADES_ALLOWED = false
```

This is an internal operating ceiling, not product pricing, public SLA, or RTO/RPO commitment. Provider upgrades must be earned by real usage, paying customers, required security or reliability capability, or an actual provider limit blocking controlled alpha.

Remaining provider items:

- Trigger production dependency-resolution behavior from the committed lockfile if still provider-dependent.
- Install `NEON_API_KEY` into Trigger Production only when managed PostgreSQL live activation is approved.
- Apply pending control-plane migrations in reviewed order before exercising new production paths.
- Run one controlled live SSC-managed database provisioning proof after migrations and credential activation.
- Keep KMS production/non-production environment separation as a future hardening/provider policy question unless current restore design makes it necessary.

`PROVIDER_CONFIGURATION_VERIFICATION = PASS_WITH_DOCUMENTED_LIMITATIONS`

`NODE_15R_13_COMPLETE = true`

`NODE_15_SPECIALIST_REVIEW = REQUIRED`

## 15. Specialist Review Questions

1. Is Vercel's build/runtime isolation acceptable for hostile small customer repositories under the planned invite-only external alpha?
2. What is the narrowest practical Vercel token/team/project scope for SSC-owned project, env, deployment, log, and delete operations?
3. Are GitHub App permissions limited to read-only contents/metadata and only the webhook permissions SSC actually consumes?
4. Are KMS IAM permissions limited to `GenerateDataKey`/`Decrypt`, and can encryption-context conditions be enforced without breaking replay?
5. Are Trigger workers and task-submission credentials isolated enough from future public API credentials and customer workloads?
6. Are 15.2 application-level tenant-boundary checks sufficient for alpha, or should DB-level composite constraints be added first?
7. Are 15.4 workload URL and redirect controls sufficient for V1 SSRF risk, including DNS rebinding considerations under `*.vercel.app`?
8. Is the secret lifecycle acceptable, including operator input, KMS envelope encryption, provider env injection, deletion, and backup/restore behavior?
9. What authorization/rate-limit/delete-confirmation controls are mandatory before exposing deploy/redeploy/delete to external users?
10. Is destructive deletion acceptable as the only emergency containment path for alpha, or is a non-destructive suspend/disable required first?

## Severity Counts

- Critical findings: 0
- High findings: 3
- Medium findings: 5
- Low findings: 3

## Conclusion

SSC has strong security foundations for a founder-operated internal proof: separation from workload execution, encrypted secrets, immutable deployment identity, recovery auditability, redacted diagnostics, and safe deletion. It is not yet safe for arbitrary external customer code.

The original highest-priority credential leak found in this packet has been resolved by 15.1. The next priority is to put any future customer-facing entrypoint behind explicit authentication, authorization, rate limits, and ownership checks instead of exposing the current operator scripts/tasks directly.

`NODE_15_COMPLETE = false`

`GATE_12_COMPLETE = false`
