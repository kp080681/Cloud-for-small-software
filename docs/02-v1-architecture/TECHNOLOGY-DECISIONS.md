# Node 02 - V1 Technology Decisions

## Purpose

This document freezes the first concrete V1 technology choices for Small Software Cloud, based on the architecture, security, reliability, portability, and bootstrap constraints defined earlier.

These are implementation decisions, not permanent company identity.

The governing principle is:

> Choose mature managed primitives now. Keep provider-specific behaviour behind adapters. Replace layers only when evidence justifies it.

## Decision status

Most decisions below are suitable to proceed into the architecture spike.

One decision remains intentionally provisional:

```text
Production runtime for arbitrary untrusted external customer code
```

Vercel is the leading V1 candidate and clearly supports platforms that programmatically host multiple user- or AI-generated codebases. However, external-alpha approval still requires a focused security review of the exact production workload isolation model.

Internal workloads may proceed earlier.

---

# 1. Primary language

## Decision

```text
TypeScript
```

Use TypeScript across the control plane, analyzer, orchestration, provider adapters, and background task code.

## Rationale

- V1 workload target is Next.js/Node.js
- strong ecosystem compatibility
- shared types between API, worker, analyzer, and provider adapters
- good GitHub/provider SDK support
- excellent AI-assisted development support
- one language lowers operating complexity

Do not introduce another server-side language without a concrete technical requirement.

---

# 2. Control Plane Framework

## Decision

```text
Next.js App Router
```

Use the current stable Next.js release at implementation time, pinned through the project lockfile.

## Role

The Next.js application owns:

- dashboard UI
- authenticated control-plane API
- GitHub installation callbacks/webhook endpoint
- configuration flows
- deployment command creation
- deployment status/event reads
- administrative/internal operator UI

Long-running deployment work remains outside synchronous request handling.

## Why

Next.js is already inside the project's explicit V1 support scope and aligns the team with the workload we are trying to operate.

This also creates internal dogfooding: our own control plane is itself a workload similar to customer workloads.

---

# 3. Control Plane Hosting

## Decision

```text
Vercel Pro
```

Use Vercel for the control-plane web/API deployment initially.

## Current pricing signal

Vercel Pro is currently listed at $20/month and includes $20 of usage credit, with pay-as-you-go usage above included amounts.

## Why

- excellent Next.js deployment path
- global delivery/TLS
- managed functions
- built-in deployment/logging facilities
- fast bootstrap
- no server administration
- spend management

## Boundary

The control plane must remain portable enough that it could later move to another Node-compatible runtime.

Do not use Vercel-specific APIs inside business logic unless behind a provider/infrastructure module.

---

# 4. Durable Background Execution

## Decision

```text
Trigger.dev Cloud initially
```

Use Trigger.dev as the managed background task/worker runtime for long-running orchestration.

Start with the Hobby tier during development/alpha where suitable, then upgrade based on reliability/support needs.

## Current pricing signal

Trigger.dev currently lists:

```text
Free: $0 + limited included credits
Hobby: $10/month with $10 usage credits
Pro: $50/month with $50 usage credits
```

Managed task execution is billed by invocation and active compute time.

## Why Trigger.dev over a raw queue initially

Our workload includes:

- provider provisioning
- builds
- polling/reconciliation
- health verification
- retries
- long-running operations
- workflow checkpoints

Trigger.dev gives us managed long-running worker execution without running worker servers ourselves.

It also supports self-hosting, preserving an escape route later.

## Why not Inngest first

Inngest is technically strong and provides durable step execution, but its current Pro tier starts around $99/month. For our earliest bootstrap stage, Trigger.dev gives a lower fixed-cost entry while satisfying the same broad background-work requirement.

## Why not Upstash Workflow first

Upstash Workflow/QStash is extremely inexpensive at low volume, with usage-based pricing around $1 per 100K workflow steps/messages.

However, our deployment orchestrator benefits from a native long-running task model rather than an HTTP-step orchestration model.

Upstash remains a strong future option for lighter queue/event workloads.

## Architectural caveat

The control-plane database remains the canonical workflow state.

Trigger.dev must not become the only place where deployment state exists.

---

# 5. Control Plane PostgreSQL

## Decision

```text
Neon Launch
```

Use a dedicated Neon PostgreSQL project for the Small Software Cloud control plane.

## Current pricing signal

Neon's current Launch plan is usage-based, with published pricing around:

```text
$0.106 per CU-hour
$0.35 per GB-month storage
```

Neon gives examples of typical small intermittent workloads around $15/month, with compute that can scale to zero when idle.

## Why Neon

- standard PostgreSQL
- usage-based compute
- scale-to-zero option
- built-in connection pooling
- API-first project management
- restore/time-travel capability
- low fixed cost
- easy future expansion
- good fit for database-per-tenant/platform scenarios

## Control-plane setting

For production control-plane use, we may disable aggressive scale-to-zero if cold-start behaviour affects the latency target.

That should be measured during the architecture spike rather than assumed.

---

# 6. Managed Customer PostgreSQL

## Decision

```text
Primary V1 candidate: Neon via PostgresProvider adapter
```

Existing external PostgreSQL databases remain fully supported through user-supplied connection secrets.

## Why Neon is preferred over Supabase for managed database provisioning

Supabase is excellent and explicitly supports platform-style project provisioning through its Management API.

However, each Supabase project includes a broader dedicated backend stack and paid projects begin around a dedicated per-project compute cost. This is useful when customers need the full Supabase feature set but can be expensive when the platform promise is simply small PostgreSQL.

Neon is more aligned with:

```text
small application -> isolated Postgres -> usage-based compute -> scale to zero
```

Neon currently supports programmatic project creation and explicitly positions its project model for large database-per-tenant/platform use cases.

Its free tier currently supports many projects for development, while paid Launch uses usage-based compute/storage.

## Important product boundary

We are provisioning PostgreSQL, not automatically replacing every backend service an application may use.

Applications already using Supabase may continue using their existing Supabase project through environment variables.

Managed Supabase provisioning can become a later provider adapter if demand shows that customers want bundled Auth/Storage/Realtime.

---

# 7. Authentication for the Control Plane

## Decision

```text
Clerk
```

Use Clerk for human authentication to the Small Software Cloud control plane.

Keep workspace membership and product authorization in our own PostgreSQL database.

## Current pricing signal

Clerk currently provides a free Hobby plan with up to 50,000 retained users per application and unlimited applications.

Pro is currently listed around $20/month when billed annually and adds production capabilities such as MFA, white-labeling, and expanded session/security options.

## Why managed auth instead of self-hosting immediately

An infrastructure platform already has enough security-critical code.

Authentication is not our differentiator.

Using managed auth reduces exposure to:

- password storage
- account recovery complexity
- leaked-password checks
- session lifecycle mistakes
- OAuth implementation mistakes

## Alternative evaluated

Better Auth is a strong TypeScript-first self-hosted framework with organizations, social auth, 2FA, passkeys, rate limiting, and PostgreSQL support.

It is a credible later option if auth-provider cost or portability becomes material.

For V1, managed auth is preferable.

## Authorization boundary

Clerk proves identity.

Our database decides:

```text
which workspace
which application
which role
which action
```

Do not make Clerk organization objects the canonical product tenancy model.

---

# 8. Customer Secret Encryption

## Decision

```text
AWS KMS + envelope encryption
```

Use one appropriately scoped customer-managed symmetric KMS key initially to protect data-encryption keys used for customer secret material.

## Current pricing signal

AWS KMS currently charges approximately:

```text
$1/month per customer-managed KMS key
20,000 requests/month free tier
then roughly $0.03 per 10,000 symmetric requests
```

## Why

- mature managed key lifecycle
- root key never leaves KMS unencrypted
- granular IAM policy
- rotation support
- auditability
- very low early cost
- independent from our control-plane database provider

## Why not simply store an encryption key as another environment variable

That would place the highest-level encryption key inside the same general application-secret system it is meant to protect.

KMS gives us a real security boundary.

## Latency impact

KMS is not in normal customer-runtime traffic.

It is used during secret creation/decryption/configuration operations, so cross-provider latency is acceptable.

---

# 9. Runtime Provider for Customer Applications

## Decision

```text
Primary V1 candidate: Vercel for Platforms
Status: APPROVED FOR INTERNAL PROOF
Status for arbitrary external code: PROVISIONAL PENDING SECURITY REVIEW
```

## Why Vercel

Vercel now explicitly offers programmatic multi-codebase platform hosting for user- or AI-generated applications, with isolated projects and individual domains.

Its Pro plan supports managed deployment, HTTPS, environment variables, build logs, rollback primitives, and usage-based compute.

This maps extremely closely to our Next.js-first gold path.

## Cost model

Vercel Pro currently starts at $20/month with included usage credit; runtime/build/network costs then grow with usage.

This keeps fixed cost small while we prove workload economics.

## Important security distinction

Vercel Sandbox is explicitly designed for untrusted code and runs each sandbox inside a Firecracker microVM.

Vercel also states that Sandbox uses the same underlying infrastructure family that powers its build system.

However, Sandbox is an ephemeral execution primitive, not automatically our long-lived production application runtime.

Therefore we must not incorrectly conclude:

```text
Sandbox supports hostile code
therefore every possible production Vercel runtime configuration is approved for arbitrary hostile workloads
```

That exact production isolation boundary must be validated during the architecture spike/security review.

## Initial safe progression

```text
DealUp
  -> DealOS
  -> Vantage
  -> controlled test repositories
  -> security review
  -> invite-only external alpha
```

This allows us to use Vercel immediately without opening uncontrolled hostile-code execution prematurely.

---

# 10. Build Isolation

## Decision

```text
Provider-managed build execution
Vercel Sandbox to be evaluated as explicit pre-build / inspection primitive where needed
```

Do not run customer dependency installation or package scripts in the control plane.

## Architecture spike question

We need to determine whether:

```text
A. Vercel's normal deployment build isolation is sufficient for our threat model
```

or whether we should:

```text
B. clone/install/test inside Vercel Sandbox first, then hand off a validated deployment path
```

or eventually:

```text
C. use another isolated build primitive
```

No external self-service launch before this is resolved.

---

# 11. DNS and TLS

## Decision

```text
V1 app URLs: runtime-provider-managed HTTPS subdomains
Control-plane DNS: Cloudflare
```

## Why

Vercel can provide domains and TLS for deployed projects, avoiding custom certificate infrastructure.

Cloudflare authoritative DNS currently provides free DNS with no query charges on Free/Pro/Business plans.

## V1 boundary

Custom customer domains are postponed until the core deployment path works.

When introduced, domain orchestration must remain behind a DNS/domain adapter.

---

# 12. Observability

## Decision

```text
Control-plane errors: Sentry Developer initially
Infrastructure/runtime metrics: provider-native dashboards first
Canonical product metrics/events: our PostgreSQL/event model
```

## Why

We do not need a full observability platform on day one.

Use provider-native runtime/build logs and metrics plus Sentry for control-plane application exceptions.

Sentry's free Developer tier is sufficient during the earliest internal phase. Current paid Team pricing is roughly in the high-$20s/month if/when collaboration, quota, and richer monitoring justify it.

## Important boundary

Provider observability is diagnostic infrastructure.

Our deployment events remain the canonical product history.

---

# 13. Source Control and CI

## Decision

```text
GitHub repository
GitHub App for customer source integration
GitHub Actions for our own CI where needed
```

## CI minimum

Before production deployment:

- typecheck
- lint
- unit tests
- state-machine tests
- provider contract tests
- migration checks
- secret leakage checks where feasible

Architecture spike may initially use a smaller subset, but critical gates should be added before external alpha.

---

# 14. ORM / SQL layer

## Decision

```text
PostgreSQL-first relational model
Implementation candidate: Drizzle ORM
```

## Status

PROVISIONAL until the first schema spike.

## Why Drizzle is a leading candidate

- TypeScript-first
- keeps SQL/database model visible
- light abstraction
- strong migration workflow
- suitable for explicit relational schemas

Prisma remains a credible alternative.

The architecture does not depend on either ORM.

## Rule

Do not allow an ORM to obscure:

- transactions
- row locking
- uniqueness constraints
- foreign keys
- migration behaviour
- query performance

---

# 15. Monorepo / package management

## Decision

```text
Single repository
pnpm
```

Potential structure:

```text
apps/
  control-plane/
  worker/                 # if separate process is still needed alongside Trigger tasks
packages/
  db/
  analyzer/
  orchestration/
  providers/
  security/
  shared/
```

Trigger.dev tasks may live inside the control-plane codebase initially rather than requiring a separate app.

Do not introduce Turborepo until the repository structure genuinely benefits from it.

---

# 16. API design

## Decision

```text
Internal product API: Next.js route handlers / server actions where appropriate
External future API: REST
```

The future CLI/MCP/agent interfaces should call stable application services rather than duplicate business logic.

Do not build the public REST API before the core web deployment flow works.

---

# 17. Infrastructure as Code

## Decision

```text
Do not introduce Terraform/Pulumi for customer workloads in V1 orchestration.
```

Our application itself is the orchestration system and calls provider APIs through adapters.

IaC may still be useful for our own static platform infrastructure later.

Adding Terraform between our orchestrator and API-driven platform resources would add another state system without immediate value.

---

# 18. Initial stack summary

```text
Language
  TypeScript

Control plane
  Next.js App Router
  Vercel Pro

Control-plane DB
  Neon Postgres

Background orchestration
  Trigger.dev

Human authentication
  Clerk

Secrets root key
  AWS KMS

Customer source
  GitHub App

Customer runtime
  Vercel for Platforms (internal proof approved; external hostile-code approval pending)

Managed customer Postgres
  Neon via provider adapter

DNS
  Vercel-assigned app domains initially
  Cloudflare for platform DNS

Observability
  Sentry + provider-native logs/metrics

Package manager
  pnpm

ORM candidate
  Drizzle
```

---

# 19. Estimated early fixed-cost shape

Ignoring workload-dependent customer compute/database usage, the fixed platform stack can begin very lean.

Indicative monthly baseline at current public pricing:

```text
Vercel Pro                       ~$20
Trigger.dev Hobby                ~$10
Clerk                            $0 initially or ~$20 Pro
AWS KMS                          ~$1 + negligible early requests
Neon control-plane DB            usage-based; small early workload roughly tens of dollars
Cloudflare DNS                   $0 initially
Sentry Developer                 $0 initially
GitHub                           existing/source control cost dependent on account plan
```

This leaves substantial room inside the project's intended early monthly infrastructure budget for usage, test databases, security tooling, and unexpected provider charges.

Customer workload cost must be tracked separately from fixed control-plane cost from the beginning.

---

# 20. Why not use Supabase everywhere

Supabase remains strategically valuable and should remain supported as an external existing service.

It is not selected as the default managed customer database provider because Small Software Cloud V1 needs PostgreSQL first, not necessarily the entire bundled Supabase platform per workload.

Supabase may later become an adapter option for applications that explicitly need:

- Supabase Auth
- Storage
- Realtime
- Edge Functions

Do not artificially migrate DealOS or Vantage away from existing Supabase services merely to make them fit the platform.

The platform should prove portability by supporting existing external dependencies cleanly.

---

# 21. Provider portability rating

```text
TypeScript / Next.js          Medium-high portability
PostgreSQL                    High portability
Neon customer DB adapter      High due to standard Postgres contract
Trigger.dev                   Medium; self-host escape route
Clerk                         Medium; identity provider can be replaced
AWS KMS                       Medium-high; standard envelope model can migrate
Vercel control plane          Medium-high for Next.js
Vercel customer runtime       Medium through RuntimeProvider abstraction
Cloudflare DNS                High
Sentry                        High
```

We are accepting some practical vendor coupling in return for dramatically lower V1 complexity.

That is intentional.

---

# 22. Architecture spike questions

The technology stack is not considered fully approved until the spike answers these questions.

## Runtime

1. Can we programmatically create an isolated Vercel project from our control plane?
2. Can we deploy a pinned GitHub revision without manually configuring Vercel dashboard state?
3. Can we reliably attach env vars and obtain build/runtime logs?
4. Can deletion/reconciliation be implemented safely?
5. What exact isolation guarantees apply to builds and production runtime for external untrusted code?

## Neon

6. Can we create/delete projects with stable reconciliation metadata?
7. What limits apply to project creation under the chosen plan?
8. How quickly does scale-to-zero resume under realistic small-app usage?
9. How do we rotate/revoke generated database credentials safely?
10. Can spend/resource caps be applied per customer database profile?

## Trigger.dev

11. Can deployment state survive task retries/restarts exactly as designed?
12. Can our PostgreSQL state machine remain canonical instead of Trigger state?
13. Can we enforce per-workspace/application concurrency?
14. Can we perform bounded polling/waits economically?

## Clerk

15. Can we keep Clerk strictly as identity while using our own workspace authorization model?
16. Are webhook/user lifecycle behaviours sufficient for account deletion/suspension flows?

## AWS KMS

17. What IAM policy allows only the worker/API secret module required encryption/decryption operations?
18. Can encryption context enforce workspace/secret binding as designed?

## Cost

19. What does one idle app cost?
20. What does one low-usage database-backed app cost?
21. What does 10 such apps cost?
22. Can hard spend limits prevent accidental runaway cost?

---

# 23. Technology decision quality gate

Before Gate 2 - Architecture Proven, confirm:

1. every selected provider has been exercised through a real API spike
2. no critical provider capability exists only as marketing assumption
3. provider write operations have reconciliation strategy
4. fixed platform cost remains compatible with bootstrap target
5. workload cost can be attributed by application
6. control plane can fail without taking live apps offline
7. customer build/runtime isolation has been explicitly validated
8. secret encryption/decryption has been tested using KMS
9. selected auth flow does not weaken workspace authorization
10. a supported Next.js test app deploys end to end without manual provider-console configuration

---

# Decision

Proceed into the V1 architecture spike using:

```text
Next.js + TypeScript
Vercel
Neon
Trigger.dev
Clerk
AWS KMS
GitHub App
Cloudflare DNS
Sentry
```

with Vercel production workload isolation for arbitrary external code explicitly marked as a security validation item rather than an assumed guarantee.

The next step is no longer another conceptual provider-selection document.

The next step should be the Node 02 completion review followed by Node 03 - Architecture Spike, where these assumptions are tested with real provider APIs and a minimal end-to-end deployment.

## Research basis

Decisions were checked against current public provider documentation/pricing in August 2026, including Vercel Platforms/Sandbox/Pricing, Neon Pricing/API documentation, Trigger.dev Pricing, Inngest Pricing, Upstash Workflow/QStash Pricing, Clerk Pricing, Better Auth documentation, AWS KMS Pricing, Cloudflare DNS documentation, Supabase Pricing/Platforms documentation, and Sentry current plan information.
