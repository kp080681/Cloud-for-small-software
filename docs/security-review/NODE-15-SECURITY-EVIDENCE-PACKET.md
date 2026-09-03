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
| Secrets | `encrypted_secrets.workspace_id/app_id`; `app_secret_bindings.workspace_id/app_id` | App scoped, encrypted | No DB-level constraint proving `binding.secret_id` belongs to same app/workspace |
| Runtimes | `app_runtimes.workspace_id/app_id`; deterministic runtime reconciliation | Scoped in data model | Public deletion/provision calls need caller authorization |
| Builds/logs/health | Deployment-scoped tables | Tied to deployment ownership indirectly | Read APIs must authorize deployment ownership |
| Provider operations | `deployment_provider_operations.deployment_id` plus provider ids | Good for recovery traceability | Read/repair operations must remain operator-only until auth exists |

Potential IDOR/cross-workspace risk: many Trigger tasks accept only `deploymentId`; `delete-app.ts` accepts `appId`, `workspaceId`, and deletion key; scripts like `set-app-secret.mjs` and diagnostic/timeline runners use app slug or deployment id. This is acceptable for current trusted local/Trigger operation, but these cannot be exposed to external users without an authenticated authorization layer.

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
- No automated wrong-tenant secret-binding test or DB constraint currently proves a binding cannot reference a secret from another app if a buggy privileged path attempts it.

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

## 6. Build Isolation

Customer build commands are inferred from `package.json` but are not executed by SSC. `prepare-build-input.ts` records commands such as `npm ci` and `npm run build`; `execute-build.ts` passes them to Vercel project/deployment settings. This keeps malicious lifecycle scripts out of the control-plane process and Trigger worker runtime.

Current controls:

- Immutable commit SHA and Git tree SHA are recorded.
- `package.json` must exist under configured root.
- Source identity mismatch during provider reconciliation fails the deployment.
- Vercel deployments include deterministic SSC metadata for recovery.
- Vercel Git auto-deployment is configured/verified through project settings helpers to keep SSC as lifecycle owner.

Remaining risks:

- Root directory normalization is shallow. It strips leading `./` but does not enforce a strict no-absolute/no-`..` invariant everywhere.
- Install/build command values originate from package manager/script names rather than arbitrary shell input, but provider build still runs arbitrary customer code in Vercel as intended.
- Provider isolation model for hostile external repositories still needs specialist validation.

## 7. Path / Source Safety

Existing defenses:

- Source comes from GitHub APIs at immutable commit/tree identity, not the local filesystem.
- Environment detector skips known generated folders and files larger than 512 KiB.
- GitHub truncated recursive trees cause detection failure rather than incomplete silent success.
- Detector scans only selected JS/TS/Next source file types and stores bounded source references.

Remaining gaps:

- No repository-wide cumulative byte/file-count limit beyond GitHub tree truncation and per-file limits.
- No explicit `rootDirectory` validation helper shared across source, provider, and script paths.
- No documented handling for symlink/submodule/source-tree edge cases.
- `apply-migration.mjs` reads an env-provided filesystem path and is an operator-only tool; it must never be externally exposed.

## 8. Network / SSRF

Provider API calls use fixed Vercel/GitHub endpoints with encoded path parameters. Public verification builds its URL from Vercel project/deployment data and performs an anonymous HTTPS GET with manual redirects.

Health verification requires HTTPS, uses `provider_deployment_url` from control-plane/provider state, and follows redirects. After 15.1 it does not include platform credentials, so redirects cannot forward platform credentials from the health request. Because the URL is expected to be a Vercel deployment URL, SSRF exposure is limited in current provider-owned flow, but host/redirect validation should still be tightened before external alpha.

SSRF classification: MEDIUM residual risk for health-check URL validation and redirect policy; original CRITICAL credential-disclosure risk from the health-check authorization header is resolved by 15.1.

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
| Source/build size | PARTIALLY_ENFORCED | Per-file env scan limit; provider build limits delegated |
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
| HIGH | Cross-tenant action by guessed deployment/app/secret id if internal task exposed | External user | Public entrypoint forwards ids without authz | Cross-tenant read/write/delete | Data model has workspace ids | High until API layer exists | Add authz facade before exposing scripts/tasks |
| HIGH | Over-scoped Vercel token mutates non-SSC projects | Attacker with token or code path bug | Token compromise or wrong project id | Broad provider damage | Deterministic runtime ids; delete identity checks | High | Verify/create least-privilege Vercel token/project scope |
| HIGH | Cross-app secret binding through privileged bug | Malicious/buggy operator path | Binding created to another app's `secret_id` | Secret exposure to wrong app | App scoped tables | Medium-high | Add DB constraint/trigger or transactional validation and tests |
| HIGH | Source scan resource exhaustion | Malicious repo | Large many-file repo under GitHub tree limit | Worker cost/delay | Per-file 512 KiB limit and truncated-tree fail closed | Medium | Add cumulative file/byte/time caps |
| HIGH | Provider build/runtime isolation insufficient for hostile code | Malicious repo | Vercel isolation not reviewed for arbitrary untrusted customers | Credential/network/resource abuse | Delegated provider isolation | Unknown | Specialist review of Vercel build/runtime isolation and env exposure |
| MEDIUM | Health/public checker SSRF via provider URL/redirect behavior | Malicious/bad provider metadata | Control-plane stores or follows unsafe URL | Internal probing | HTTPS requirement; public check manual redirect | Medium | Validate host suffix/project binding; limit redirects consistently |
| MEDIUM | No non-destructive suspension | Abusive customer workload | Abuse detected before deletion decision | Slow containment or destructive-only response | Delete and abandon exist | Medium | Add operator suspend/disable path before external alpha |
| MEDIUM | Provider/API error text may expose sensitive data in operator surfaces | Provider/application failure | Error propagated to Trigger/local output | Info disclosure | Diagnostics redact and avoid raw provider bodies | Medium | Review/logging policy for all stored/printed error messages |
| MEDIUM | Secret digest printed by set-app-secret | Insider/log collector | Operator uses script with sensitive value | Offline comparison for low-entropy secrets | Plaintext not printed | Medium | Stop printing digest |
| MEDIUM | No public API rate limiting yet | External user | Customer API added without limiter | Cost/abuse exposure | Resource policy in worker | Medium | Add rate limits before exposing customer actions |
| MEDIUM | Root directory traversal/absolute path inconsistencies | Malicious configuration | Public config accepts root directory | Wrong source/provider path | GitHub API path usage; provider path normalized | Medium | Central strict root-directory validator |
| LOW | Immutable string clearing is ineffective | Local process/memory attacker | Process memory inspected | Secret remnants in memory | Short-lived scripts/workers | Low | Avoid claims of memory wiping; keep lifetime short |
| LOW | Orphan fixture script creates intentional unmanaged deployment if run | Operator error | Guarded script run against disposable project | Provider clutter/cost | Hard-coded disposable guard | Low | Keep script operator-only; document no cleanup in node |
| LOW | Runtime logs not fully ingested | Operator/customer | Runtime failure after deploy | Reduced visibility | Health diagnostics and provider ids | Low | Define V1 provider-log access boundary |

## 14. Security Blockers

ALPHA_BLOCKER:

- Public/customer entrypoints do not yet exist as hardened authenticated/authorized APIs; current scripts/tasks must not be exposed as-is.
- Specialist review of provider build/runtime isolation and credential scopes is still required by the master graph/security model.

HARDEN_BEFORE_BETA:

- Add DB or transactional validation that secret bindings cannot cross app/workspace boundaries.
- Add cumulative source-analysis limits and shared root-directory validation.
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

## 15. Specialist Review Questions

1. Is Vercel's build/runtime isolation acceptable for hostile small customer repositories under the planned invite-only external alpha?
2. What is the narrowest practical Vercel token/team/project scope for SSC-owned runtime mutation?
3. Should health verification ever authenticate to provider-protected URLs, or should V1 only perform anonymous checks?
4. What DB-level controls should enforce `app_secret_bindings.secret_id` ownership?
5. What minimum tenant-authorization tests are required before exposing deployment actions to external users?
6. Are GitHub App permissions limited to read-only contents/metadata and webhook access?
7. Are Trigger workers separated enough from public API credentials and ordinary user-triggered surfaces?
8. Are KMS IAM permissions and encryption-context conditions narrow enough?
9. What source-size and analysis-time limits are sufficient for external alpha?
10. What non-destructive suspension capability is acceptable before external alpha?
11. Are current redaction rules enough for provider logs and diagnostic/timeline output?
12. What backup/restore controls are needed for encrypted secret material in restored control-plane databases?

## Severity Counts

- Critical findings: 0
- High findings: 5
- Medium findings: 6
- Low findings: 3

## Conclusion

SSC has strong security foundations for a founder-operated internal proof: separation from workload execution, encrypted secrets, immutable deployment identity, recovery auditability, redacted diagnostics, and safe deletion. It is not yet safe for arbitrary external customer code.

The original highest-priority credential leak found in this packet has been resolved by 15.1. The next priority is to put any future customer-facing entrypoint behind explicit authentication, authorization, rate limits, and ownership checks instead of exposing the current operator scripts/tasks directly.

`NODE_15_COMPLETE = false`

`GATE_12_COMPLETE = false`
