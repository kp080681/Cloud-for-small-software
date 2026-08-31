# AGENTS.md — Small Software Cloud

## Mission
Build a global, bootstrapped infrastructure platform for small software.

Core promise: **Build anywhere. Run here.**
Long-term vision: **The home for small software.**

The platform exists to make ordinary small applications operational: deployment, runtime, PostgreSQL, authentication integration, users/permissions, secrets, domains/TLS, logs, backups, maintenance and later agent-native operation.

## What this project is not
Do not turn this repository into an IDE, AI code generator, no-code builder, Kubernetes dashboard, generic hosting reseller, CRM, AWS clone, or framework zoo.

## V1 scope
Supported source/runtime target is deliberately narrow:
- GitHub source
- Next.js
- Node.js
- PostgreSQL

Core capabilities:
- Accounts/workspaces
- GitHub connection and repository selection
- Framework/build detection
- Environment variables and encrypted secrets
- PostgreSQL provisioning
- Deployment
- HTTPS URL
- Deployment status
- Basic logs
- Redeploy
- Delete app
- Basic resource limits

Later, only after the core is reliable:
- Custom domains
- Rollback
- Backups
- Team sharing
- Authentication gateway
- Usage metering
- Billing

Do not add new runtimes/frameworks without genuine user demand.

## Product principle
The platform should feel simple, technical, calm, premium and trustworthy.
Its value is smooth operation, not feature count.

Before building anything ask:
**Does this directly help us deploy, operate, secure or monetize small software?**
If not, it is probably not V1.

## Architecture principle
Do not build underlying cloud infrastructure from scratch initially. Use mature providers for compute, PostgreSQL, networking, DNS, TLS, storage and monitoring.

Current provider pattern:
- Vercel for application runtime/builds
- Trigger.dev for durable control-plane execution
- AWS KMS for secret encryption
- GitHub App for repository access
- PostgreSQL for control-plane state
- Neon may be used for managed PostgreSQL workloads

Keep the control plane separate from customer workloads.

Core rule: **REVENUE EARNS COMPLEXITY.**

## Security requirements
Security is Day-1 architecture.
Design for:
- tenant/workload isolation
- encrypted secrets
- CPU/memory/storage limits
- build isolation
- controlled networking
- rate limits
- abuse prevention
- auditability
- least-privilege credentials
- safe deletion

Never log or persist plaintext secrets. Never print installation tokens, private keys or provider credentials. Never add platform-specific hacks to make a test app pass.

## Bootstrapping constraints
This must remain capital-efficient and founder-controlled.
Prefer managed infrastructure, open source, AI-assisted engineering and usage-based services. Avoid premature infrastructure ownership, enterprise tooling, large fixed costs or premature hiring.

## Proven control-plane baseline (Node 04)
The following lifecycle has been implemented and exercised end-to-end:

GitHub mapping → immutable source identity → build input → runtime provisioning → encrypted env/secrets → resource policy → direct production deployment → build reconciliation → build log ingestion → health check → anonymous public HTTPS verification → LIVE → redeploy → safe app deletion → provider cleanup → idempotent deletion replay.

Important lifecycle decisions already made:
- Deploy Vercel workloads directly to `target: production` for V1.
- The previous Preview → Promote approach was retired after Vercel returned 422 on promotion.
- A deployment is not `LIVE` merely because a provider build is healthy.
- `LIVE` is reached only after anonymous public access to the canonical production URL is verified.
- Deployment history is immutable; corrections create new deployments/redeployments.
- An explicit abandonment path exists for superseded active deployments.
- App deletion is idempotent and removes provider runtime, runtime binding and encrypted secrets while preserving historical control-plane records.

## Current internal workloads
Use ordinary applications as portability tests. Do not introduce hidden app-specific behavior.
- Vantage — already deployed through SSC and currently the primary live proof workload.
- DealOS — future proof workload.
- DealUp websites — future proof workload.
- Disposable lifecycle test app was used to validate failure/recovery/delete paths and has been deleted.

## Current engineering phase
Do **not** add product features now.
The next block is hardening: reliability, security, observability and portability.

### Current task: Node 04.17 — Source-Aware Environment Requirements
Goal: every deployment/redeployment must analyse the exact frozen source commit and establish environment requirements before provisioning/build execution.

Desired lifecycle:

ANALYZING
1. Prepare immutable build input for the exact deployment commit.
2. Detect environment-variable references from that exact frozen source.
3. Reconcile detected requirements.
4. Verify required configuration exists in SSC.
5. Only then advance to PROVISIONING.

PROVISIONING → BUILDING → DEPLOYING → HEALTH_CHECKING → LIVE

Requirements for 04.17:
- Never inspect a developer's local filesystem as the source of truth.
- Use `deployment_build_inputs` (repository, commit SHA, Git tree SHA, root directory) and GitHub App access.
- Detection must be commit-scoped and reproducible.
- Avoid pretending arbitrary JavaScript can be perfectly classified. `process.env.X` is a reference, not always proof that X is mandatory.
- Preserve explicit/user-confirmed requirements; do not silently delete requirements simply because a later scan does not observe them.
- Introduce a deployment-scoped detection snapshot so historical deployments can answer what SSC detected at that exact commit.
- Separate detection from verification: detection answers “what does this source appear to need?”; verification answers “does SSC have the configuration required to deploy it?”
- Missing known-required configuration must block before provider build execution.
- Keep changes bounded to this node; no UI work, no unrelated refactors, no new frameworks/providers.

## Relevant existing files for 04.17
Inspect these before changing code:
- `control-plane/trigger/prepare-build-input.ts`
- `control-plane/trigger/orchestrate-deployment.ts`
- `control-plane/trigger/apply-runtime-env.ts`
- `control-plane/db/005_app_env_requirements.sql`
- `control-plane/db/002_deployment_build_inputs.sql`
- `control-plane/scripts/seed-vantage-env-requirements.mjs` (legacy Vantage-specific bootstrap only; do not generalize by hard-coding)
- `control-plane/scripts/verify-env-requirements.mjs`
- secret-binding / encrypted-secret schema and code

## Change discipline
When working on this repository:
1. Read the relevant code and migrations first.
2. State the intended state-machine change before editing.
3. Prefer small explicit migrations over implicit schema behavior.
4. Preserve idempotency and replay safety.
5. Keep provider-specific behavior behind control-plane tasks.
6. Never mutate historical deployments to make tests pass.
7. Do not touch Vantage application code unless the task explicitly requires it.
8. Do not perform manual provider-side fixes as part of normal flow; SSC should own the operation.
9. Run available type-check/build/tests for the control plane after changes.
10. Report files changed, schema changes, state transitions affected, tests run, and any unresolved risks.

## Working style for Codex
This repository is an infrastructure/control-plane project. Treat correctness and state transitions as more important than code elegance.
Do not perform broad refactors unless explicitly requested.
Do not add abstractions “for the future” unless needed for the current hardening node.
When uncertain about provider behavior, inspect current provider documentation/code paths rather than guessing.
