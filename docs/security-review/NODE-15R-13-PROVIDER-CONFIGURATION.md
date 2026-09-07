# Node 15R.13 Provider Configuration Verification

Status: provider configuration verification is `PASS_WITH_DOCUMENTED_LIMITATIONS` for founder-operated controlled alpha. No production provider configuration, provider resources, databases, migrations, workloads, or Trigger deployments were changed while recording this evidence.

## Summary

| Provider area | Status |
| --- | --- |
| GitHub security/least privilege | PASS |
| Vercel project identity | PASS |
| Vercel credential least privilege | PARTIAL |
| Vercel Git auto-deploy live behavior | PASS_DISCONNECTED_NO_AUTODEPLOY_OBSERVED |
| Vercel environment isolation | PASS_VISUAL |
| Vercel spend containment | PLAN_LIMITED_ACCEPTED |
| AWS IAM/KMS | PASS |
| Trigger environment isolation | PASS |
| Trigger credential least privilege | PARTIAL_ROOT_KEY |
| Trigger resource ceiling | PASS |
| Neon credential least privilege | PARTIAL_ORG_WIDE |
| Neon resource ceiling | PASS |
| Neon recovery | PASS |

## GitHub

Observed GitHub App installation:

```text
GITHUB_CODE_ACCESS = READ_ONLY
GITHUB_METADATA_ACCESS = READ_ONLY
GITHUB_WRITE_ACCESS = NONE
GITHUB_ADMIN_ACCESS = NONE
GITHUB_REPOSITORY_SCOPE = SELECTED_ONLY
GITHUB_ALL_REPOSITORIES_ACCESS = false
```

Selected repositories:

- `kp080681/dealupwebsite`
- `kp080681/Vantage`
- `kp080681/Cloud-for-small-software`

Provider configuration status:

```text
GITHUB_PROVIDER_STATUS = PASS
```

## Vercel

Current SSC token:

```text
VERCEL_TOKEN_SCOPE = USER
VERCEL_TOKEN_TEAM_SCOPED = false
VERCEL_CREDENTIAL_LEAST_PRIVILEGE = PARTIAL
```

Interpretation: acceptable for founder-operated controlled alpha with current SSC controls. This is not acceptable as the final credential model for public/self-service execution if narrower provider credentials become available.

Live SSC project identity:

```text
DEALUP_PROVIDER_IDENTITY = PASS
VANTAGE_PROVIDER_IDENTITY = PASS
PRODUCTION_PROJECT_BINDINGS = PASS
```

Verified DealUp:

```text
project: ssc-dealup-website
projectId: prj_DenX1PfUvk7yTNEJ61jafDyOGT6P
gitRepository: kp080681/dealupwebsite
productionBranch: main
```

Verified Vantage:

```text
project: ssc-vantage
projectId: prj_6sEdW0atFf67CUIf2lpkAru63sji
gitRepository: kp080681/Vantage
productionBranch: main
```

Environment isolation:

```text
VERCEL_TEAM_SHARED_CONTROL_PLANE_SECRETS_OBSERVED = false
CONTROL_PLANE_CREDENTIAL_INHERITANCE_RISK_OBSERVED = false
PROJECT_ENV_ISOLATION = PASS_VISUAL
```

The review found no observed workload-project inheritance of `VERCEL_TOKEN`, `NEON_API_KEY`, AWS credentials, Trigger secrets, GitHub App private key, or the control-plane database URL. Legacy application secrets targeting Production and Preview are application configuration, not a control-plane credential leak; 15R.8 controls new SSC-managed secret application as production-only.

Git auto-deploy:

```text
VERCEL_GIT_REPOSITORY_CONNECTED = false
VERCEL_GIT_AUTODEPLOY_CODE_CONTROL = PASS
VERCEL_GIT_AUTODEPLOY_LIVE_SETTING_VISIBLE = false
VERCEL_GIT_AUTODEPLOY_LIVE = PASS_DISCONNECTED_NO_AUTODEPLOY_OBSERVED
```

Live disposable verification showed Vercel can report a connected GitHub project as `git=null` with `link` present. It also showed that `PATCH /v9/projects/{id}` with `{ "git": { "deploymentEnabled": false } }` returns HTTP 400 through SSC's current REST path. SSC therefore no longer treats `git.deploymentEnabled=false` as a successful containment mechanism for controlled alpha.

15R.6 now treats only absent/disconnected project Git linkage as safe. Connected or unknown state fails closed before runtime attachment, secret injection, or provider build creation. Production projects must not be silently disconnected by this node; a supported provider disconnect operation must be separately reviewed before automation.

Live behavioral verification then manually disconnected only the disposable project `ssc-ssc-recovery-test` (`prj_vVfWE0VMyYvABEUkQFa3X8oEYOhj`) from `kp080681/ssc-lifecycle-test`. The Vercel project API returned `git:null` and `link:null`. Before a harmless empty commit to `kp080681/ssc-lifecycle-test` `main`, the provider deployment count was 3 and the latest deployment was `dpl_231x5RiipsGgzEqaVG7NmdnD47Sm`. After waiting and re-reading deployments, the API returned status 200, deployment count 3, and latest deployment `dpl_231x5RiipsGgzEqaVG7NmdnD47Sm`. The Git push created zero out-of-band Vercel deployments.

Spend:

```text
VERCEL_PLAN = HOBBY
VERCEL_SPEND_MANAGEMENT = NOT_AVAILABLE_ON_CURRENT_PLAN
VERCEL_PAID_ON_DEMAND_USAGE = NOT_ENABLED
VERCEL_SPEND_CONTAINMENT = PLAN_LIMITED_ACCEPTED
```

## AWS IAM/KMS

Observed runtime IAM access:

```text
AWS_KMS_RUNTIME_ACTIONS = GenerateDataKey + Decrypt
AWS_KMS_RESOURCE_SCOPE = SINGLE_SPECIFIC_KEY
AWS_KMS_RUNTIME_ADMIN_ACCESS = NONE
AWS_KMS_WILDCARD_RUNTIME_ACCESS = false
AWS_KMS_LEAST_PRIVILEGE = PASS
AWS_KMS_PROVIDER_CONFIGURATION = PASS
```

The key policy uses standard account IAM delegation. The runtime access observed for SSC is supplied through the dedicated inline policy and does not include key administration.

## Trigger.dev

Production runtime environment:

```text
TRIGGER_PRODUCTION_ENVIRONMENT_ISOLATION = PASS
CONTROL_PLANE_PROVIDER_CREDENTIAL_LOCATION = EXPECTED
CUSTOMER_APP_SECRETS_IN_TRIGGER = NONE_OBSERVED
TRIGGER_ROOT_API_KEY_IN_RUNTIME_ENV = NOT_OBSERVED
NEON_API_KEY_IN_RUNTIME_ENV = ABSENT
```

API keys:

```text
TRIGGER_PROJECT_KEY_SCOPE = PROJECT
TRIGGER_ROOT_KEY_SCOPE = ROOT
TRIGGER_CREDENTIAL_SEPARATION = PASS
TRIGGER_ROOT_CREDENTIAL_LEAST_PRIVILEGE = PARTIAL
```

Plan/resource ceiling:

```text
TRIGGER_PLAN = FREE
TRIGGER_CONCURRENT_RUN_LIMIT = 20
TRIGGER_PLAN_RESOURCE_CEILING = PRESENT
TRIGGER_PAID_UPGRADE_REQUIRED_FOR_ALPHA = false
```

## Neon

API credential:

```text
NEON_API_KEY_SCOPE = ORGANIZATION_WIDE
NEON_API_KEY_PRIVILEGE = ADMIN_LEVEL
NEON_PROJECT_SCOPED_CREDENTIAL = false
NEON_CREDENTIAL_LEAST_PRIVILEGE = PARTIAL
```

Interpretation: broader than ideal, but acceptable for founder-controlled alpha with explicit database ownership, provider identity checks, workspace/app identity, managed DB quota, idempotent lifecycle, safe deletion, inventory/orphan support, and recovery proof.

Plan/resource ceiling:

```text
NEON_PLAN = FREE
NEON_MONTHLY_FIXED_COST = 0
NEON_PAID_USAGE = DISABLED
NEON_RESOURCE_CEILING = PRESENT
```

Provisioning and recovery:

```text
NEON_MANAGED_DB_PROVISIONING_CODE = PASS
NEON_PROVIDER_NATIVE_RECOVERY = PASS
NEON_RECOVERY_PARITY = PASS
NEON_DISPOSABLE_RESOURCE_CLEANUP = PASS
```

15R.12B proved Neon project creation, synthetic data creation, LSN capture, destructive mutation, branch restore, exact row-count parity, exact SHA-256 digest parity, and cleanup using a disposable SSC-managed resource.

Production managed database live activation was later verified during PRE_15R_14 using the disposable SSC Recovery Test app. Trigger production deploy version `20260907.1` succeeded from the committed dependency graph, the Neon credential was corrected in Trigger Production after an initial 401, and the existing SSC KMS key ARN was configured after the recovery path exposed a missing `AWS_KMS_KEY_ID`. The live proof created exactly one SSC-named Neon project and then reconciled that existing provider project on retry rather than creating a duplicate.

## Controlled-Alpha Operating Boundary

```text
CONTROLLED_ALPHA_INFRA_BUDGET_USD = 100
PROVIDER_PREEMPTIVE_UPGRADES_ALLOWED = false
```

This is an operating ceiling, not a product price. The older approximate INR 20,000/month bootstrap ceiling remains an upper capital constraint, but controlled alpha should target at or below USD 100/month.

Do not upgrade providers merely because a paid tier exists. Provider upgrades must be earned by real usage, paying customers, required security capability, required reliability capability, or provider limits genuinely blocking controlled alpha.

Short-lived disposable proof resources may temporarily consume incremental usage when required to prove recovery or security, but must be cleaned up.

## Remaining Live Actions

1. Trigger production dependency-resolution behavior from the committed lockfile if still provider-dependent.
2. Keep KMS production/non-production environment separation as a future hardening/provider policy question unless current restore design makes it necessary.

## Disposable Vercel Git Auto-Deploy Verification Result

Use only the disposable recovery-test/lifecycle-test project. Do not use DealUp, Vantage, or DealOS.

1. Manually disconnected the disposable Vercel recovery-test project from Git in the Vercel dashboard.
2. Verified the project API response reported `git: null` and `link: null`.
3. Recorded the baseline provider deployment count for the disposable project: 3.
4. Recorded the baseline latest deployment: `dpl_231x5RiipsGgzEqaVG7NmdnD47Sm`.
5. Made a harmless empty commit to `kp080681/ssc-lifecycle-test` on `main`.
6. Waited long enough for provider Git automation to appear if still active.
7. Re-read the provider deployment list and observed status 200, deployment count 3, and latest deployment `dpl_231x5RiipsGgzEqaVG7NmdnD47Sm`.

Observed result:

```text
VERCEL_GIT_AUTODEPLOY_LIVE = DISCONNECTED_NO_AUTODEPLOY_OBSERVED
GIT_PUSH_CREATED_OUT_OF_BAND_DEPLOYMENTS = 0
```

## Managed PostgreSQL Live Activation Result

Disposable workload:

```text
deploymentId: 7177b871-2c70-4afd-bd12-bab6fedfaed2
app: SSC Recovery Test
appId: 6bc015df-ccb1-4151-982e-3ea24e45c54b
workspaceId: 1527483e-69a3-4771-9bf1-b54a70028d9e
databaseMode: SSC_MANAGED
```

Verified sequence:

1. Deployment entered `ANALYZING` through the canonical queue path.
2. Orchestrator advanced through `BUILD_INPUT_PREPARED`, `ENV_REQUIREMENTS_DETECTED`, `ENV_REQUIREMENTS_VERIFIED`, and `PROVISIONING`.
3. Managed database intent was recorded.
4. Initial Neon credential in Trigger Production returned Neon API 401 Unauthorized.
5. Correct Neon credential was installed.
6. Neon created exactly one SSC-named project: `patient-tooth-74331988` / `ssc-6bc015dfccb1-408986212cc5-db`.
7. SSC remained locally at `CREATE_REQUESTED` with `provider_project_id` null after a downstream failure.
8. Read-only Neon lookup found exactly one matching provider project, proving recoverable provider-side creation and no duplication.
9. Trigger provisioning retries then failed after provider observation because `AWS_KMS_KEY_ID` was missing.
10. Existing SSC KMS key ARN was recovered from `encrypted_secrets.kms_key_id` and configured in Trigger Production.
11. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_KMS_KEY_ID` were confirmed present.
12. The orchestrator was retriggered against the same deployment.
13. SSC reconciled the existing Neon project rather than creating another.
14. Final verified state: deployment status `PROVISIONING`, database status `READY`, provider `neon`, provider project id `patient-tooth-74331988`, provider project name `ssc-6bc015dfccb1-408986212cc5-db`, provider database name `neondb`, provider role name `neondb_owner`, connection secret id `f3f828ef-fc1a-4079-88d0-482bf9e1a6d0`, reconciliation key `database:neon:1527483e-69a3-4771-9bf1-b54a70028d9e:6bc015df-ccb1-4151-982e-3ea24e45c54b`.
15. `DATABASE_READY` event recorded: "Managed PostgreSQL is ready for runtime binding".
16. No plaintext database URI was printed.
17. No duplicate Neon project was created.

This closes the managed PostgreSQL live activation/provisioning proof for PRE_15R_14. It does not claim the disposable application itself reached `LIVE`, and the Neon project was intentionally not deleted as part of this evidence update.

## Decision

```text
PROVIDER_CONFIGURATION_VERIFICATION = PASS_WITH_DOCUMENTED_LIMITATIONS
NODE_15R_13_COMPLETE = true
NEXT_NODE = 15R.14_INDEPENDENT_ADVERSARIAL_RE_REVIEW
```

Known limitations remain:

- Vercel user-scoped token.
- Trigger unrestricted Root key exists operator-side.
- Neon org-wide API key.

These do not automatically block founder-operated controlled alpha. They matter before public/self-service operation.
