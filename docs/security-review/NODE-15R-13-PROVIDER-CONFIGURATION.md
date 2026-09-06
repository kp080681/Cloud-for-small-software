# Node 15R.13 Provider Configuration Verification

Status: provider configuration verification is `PASS_WITH_DOCUMENTED_LIMITATIONS` for founder-operated controlled alpha. No production provider configuration, provider resources, databases, migrations, workloads, or Trigger deployments were changed while recording this evidence.

## Summary

| Provider area | Status |
| --- | --- |
| GitHub security/least privilege | PASS |
| Vercel project identity | PASS |
| Vercel credential least privilege | PARTIAL |
| Vercel Git auto-deploy live behavior | PENDING_DISPOSABLE_BEHAVIOR_TEST |
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
VERCEL_GIT_REPOSITORY_CONNECTED = true
VERCEL_GIT_AUTODEPLOY_CODE_CONTROL = PASS
VERCEL_GIT_AUTODEPLOY_LIVE_SETTING_VISIBLE = false
VERCEL_GIT_AUTODEPLOY_LIVE_VERIFICATION = PENDING_DISPOSABLE_BEHAVIOR_TEST
```

15R.6 code sets and verifies `git.deploymentEnabled=false`, corrects adopted projects, checks drift before build, and fails closed on unknown state. The live dashboard/API review did not expose the effective value, so this remains a disposable behavior-test item.

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

Production managed database live path still requires migration application, `NEON_API_KEY` installation into Trigger Production, and one controlled live provisioning verification. Do not perform those in this node.

## Controlled-Alpha Operating Boundary

```text
CONTROLLED_ALPHA_INFRA_BUDGET_USD = 100
PROVIDER_PREEMPTIVE_UPGRADES_ALLOWED = false
```

This is an operating ceiling, not a product price. The older approximate INR 20,000/month bootstrap ceiling remains an upper capital constraint, but controlled alpha should target at or below USD 100/month.

Do not upgrade providers merely because a paid tier exists. Provider upgrades must be earned by real usage, paying customers, required security capability, required reliability capability, or provider limits genuinely blocking controlled alpha.

Short-lived disposable proof resources may temporarily consume incremental usage when required to prove recovery or security, but must be cleaned up.

## Remaining Live Actions

1. Vercel disposable Git auto-deploy behavioral verification.
2. Trigger production dependency-resolution behavior from the committed lockfile if still provider-dependent.
3. Install `NEON_API_KEY` into Trigger Production only when managed PostgreSQL live activation is approved.
4. Apply pending control-plane migrations in reviewed order before exercising new production paths.
5. Run one controlled live SSC-managed database provisioning proof after migrations and credential activation.
6. Keep KMS production/non-production environment separation as a future hardening/provider policy question unless current restore design makes it necessary.

## Decision

```text
PROVIDER_CONFIGURATION_VERIFICATION = PASS_WITH_DOCUMENTED_LIMITATIONS
NODE_15R_13_COMPLETE = true
NEXT_NODE = PRE_15R_14_LIVE_ACTIVATION
```

Known limitations remain:

- Vercel user-scoped token.
- Trigger unrestricted Root key exists operator-side.
- Neon org-wide API key.
- Disposable Vercel Git auto-deploy behavioral proof pending.
- Neon production credential not yet installed.
- Pending database migrations.

These do not automatically block founder-operated controlled alpha. They matter before public/self-service operation.
