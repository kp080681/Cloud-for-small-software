# Node 02 - V1 Application Analyzer Specification

## Purpose

The Application Analyzer turns a GitHub repository at an immutable commit into a deterministic, explainable deployment compatibility decision.

The analyzer does not execute customer code. It inspects repository structure and selected configuration/source files, applies versioned rules, and produces a persisted analysis result.

The governing principle is:

> Deterministic first. Explainable always. AI-assisted only where uncertainty remains.

## Core output

Every completed analysis must produce:

- detected framework
- detected runtime
- detected package manager
- install command
- build command
- environment variable requirements
- PostgreSQL requirement
- unsupported features/dependencies
- compatibility verdict
- evidence/reasons
- analyzer version

The verdict must be one of:

```text
SUPPORTED
NEEDS_CONFIGURATION
UNSUPPORTED
```

## Analyzer inputs

The analyzer receives:

- repository identity
- immutable commit SHA
- selected application root
- repository tree metadata
- package manifest
- lockfile metadata
- framework configuration
- runtime declaration files
- env example files
- selected source/config files required for static detection
- analyzer rule version

The analyzer must not use a moving branch reference after analysis begins.

## Analysis phases

```text
1. Source preflight
2. Project root detection
3. Package manager detection
4. Runtime detection
5. Framework detection
6. Build/install detection
7. Environment-variable detection
8. PostgreSQL/database detection
9. Unsupported-feature detection
10. Compatibility evaluation
11. Persist evidence and verdict
```

## Phase 1 - Source preflight

Before deeper inspection, reject or flag source layouts that cannot be analysed safely.

Checks include:

- repository access still valid
- selected commit exists
- repository tree below configured limits
- required manifest present where expected
- no critical source dependency on unsupported acquisition method

Potential blockers:

```text
REPOSITORY_TOO_LARGE
MISSING_PACKAGE_MANIFEST
UNSUPPORTED_GIT_SUBMODULE_REQUIREMENT
UNSUPPORTED_GIT_LFS_REQUIREMENT
UNSUPPORTED_PROJECT_LAYOUT
```

The analyzer should distinguish `cannot analyse` from `analysed and unsupported` internally, even if both may surface as unsupported to the user.

## Phase 2 - Project root detection

Earliest V1 should prefer one explicit application root.

Default:

```text
/
```

Future/optional:

```text
/apps/web
/frontend
```

If multiple plausible app roots exist and no deterministic rule resolves them, return a configuration request rather than guessing.

Example:

```text
NEEDS_CONFIGURATION
Reason: Multiple Node applications detected. Select the application root.
```

## Phase 3 - Package manager detection

Use deterministic evidence in priority order.

### Lockfile evidence

```text
pnpm-lock.yaml     -> pnpm
package-lock.json  -> npm
yarn.lock          -> yarn
bun.lock / bun.lockb -> bun only if V1 explicitly supports Bun
```

Earliest V1 may support only npm/pnpm/yarn.

### packageManager field

If `package.json` contains a valid `packageManager` declaration, use it as supporting evidence.

### Conflict handling

If multiple incompatible lockfiles exist:

```text
NEEDS_CONFIGURATION
```

or `UNSUPPORTED` if V1 chooses not to resolve ambiguity.

Do not silently select one.

## Phase 4 - Node.js runtime detection

Evidence sources may include:

- `package.json.engines.node`
- `.nvmrc`
- `.node-version`
- provider-neutral runtime config files

Normalize to a platform-supported runtime range/profile.

Example:

```text
NODE_20
NODE_22
```

Do not expose arbitrary provider runtime naming as the product model.

### Runtime compatibility

If the requested Node version is outside supported V1 range:

```text
UNSUPPORTED
Reason: Node.js runtime version is outside the supported range.
```

If no runtime is declared, use a documented platform default and record that assumption in evidence.

## Phase 5 - Framework detection

### Next.js

Strong evidence:

- `next` dependency in `dependencies` or `devDependencies`
- Next.js configuration file where present
- standard Next.js source structure as secondary evidence

Framework result:

```text
NEXTJS
```

### Generic Node.js

If no supported framework is detected but the repository is a supported Node application with a valid start/build model:

```text
NODE
```

However, generic Node support should only be enabled once runtime-provider architecture has been validated for it.

### Conflict handling

If multiple major application frameworks appear to define separate deployable applications, do not guess.

Return:

```text
NEEDS_CONFIGURATION
```

with evidence.

## Phase 6 - Install command detection

Derive from package manager.

Examples:

```text
npm  -> npm ci when lockfile supports it
pnpm -> pnpm install --frozen-lockfile
yarn -> deterministic/frozen install mode appropriate to supported Yarn version
```

Do not execute install during static analysis.

The exact command is a deployment-plan output for the isolated build provider.

## Phase 7 - Build command detection

Prefer explicit package scripts.

### Next.js default

If `scripts.build` exists, use it.

Typical:

```text
npm run build
pnpm build
yarn build
```

If no build script exists but framework conventions safely define one, V1 may synthesize a documented default only when validated.

Otherwise:

```text
NEEDS_CONFIGURATION
Reason: Build command could not be determined safely.
```

## Start/runtime command detection

For provider-managed Next.js runtimes, a custom long-running start command may not be required.

For generic Node workloads, start behaviour must be deterministic.

Potential evidence:

- `scripts.start`
- explicit platform configuration

If generic Node support requires a start command and it is absent:

```text
NEEDS_CONFIGURATION
```

## Phase 8 - Environment-variable detection

The analyzer should combine multiple evidence sources.

### Strong sources

- `.env.example`
- `.env.sample`
- documented environment example files
- explicit framework configuration references

### Static source references

Search selected text source/config files for patterns such as:

```text
process.env.NAME
process.env["NAME"]
```

Potential future patterns may include framework-specific environment APIs.

### Classification

Each detected variable should include:

```text
key
required_confidence
source_evidence
sensitivity_hint
management_source
```

### Public variables

Framework conventions may designate some variables as intentionally browser-exposed, e.g. public prefixes.

The analyzer should classify these separately from secret candidates.

Public does not mean safe to invent.

## Required vs optional environment variables

This is a difficult area and must remain conservative.

A static reference alone does not always prove production requirement.

V1 can use confidence classes such as:

```text
REQUIRED
LIKELY_REQUIRED
OPTIONAL
UNKNOWN
```

Only strongly evidenced required values should block deployment automatically.

The UI can still surface likely/unknown values for review.

## Secret sensitivity hints

Use key-name heuristics only as hints.

Examples likely sensitive:

```text
*_SECRET
*_TOKEN
*_PASSWORD
*_API_KEY
DATABASE_URL
PRIVATE_KEY
```

Never assume a value is safe merely because its key name looks non-sensitive.

User-provided values marked secret stay secret.

## Phase 9 - PostgreSQL/database detection

The analyzer should identify whether the app appears to require PostgreSQL.

Evidence may include:

- known PostgreSQL client dependencies
- ORM dependencies plus PostgreSQL-specific adapters/config
- `DATABASE_URL` usage
- Prisma schema provider
- Drizzle/Knex/Sequelize configuration where deterministically inspectable
- Supabase client/server dependencies where database usage is implied

### Important distinction

Detect:

```text
DATABASE_REQUIRED
```

separately from:

```text
MANAGED_DATABASE_REQUIRED
```

The platform should allow an existing database connection when supported.

### Ambiguity

If database usage is plausible but not certain:

```text
NEEDS_CONFIGURATION
```

may ask:

```text
Does this application require PostgreSQL?
```

rather than provisioning unnecessarily.

## Supabase detection

Supabase may represent several capabilities:

- PostgreSQL
- Auth
- Storage
- Realtime

V1 should not assume that detecting `@supabase/*` means the platform should automatically replace/provision every Supabase capability.

For existing applications, first-class support can mean:

```text
Use existing Supabase project via provided environment variables.
```

Managed replacement/provisioning is a separate product decision.

## Phase 10 - Unsupported-feature detection

Earliest V1 should explicitly detect or conservatively flag known out-of-scope requirements.

Examples:

- Python runtime
- PHP
- Java
- .NET
- Docker Compose
- required Redis
- GPU/CUDA
- multiple independently deployed services
- custom privileged containers
- unsupported native/system dependencies
- long-running background daemons when runtime provider cannot support them
- required local persistent filesystem

The analyzer does not need perfect universal detection.

It needs enough evidence to avoid falsely claiming support.

## Native dependencies

Node packages with native compilation requirements can behave differently across build environments.

V1 should maintain an evolving compatibility list.

Categories:

```text
KNOWN_GOOD
KNOWN_UNSUPPORTED
REQUIRES_BUILD_VALIDATION
UNKNOWN
```

Do not pretend static analysis can fully prove native binary compatibility.

## External service dependencies

Dependencies such as:

- Redis
- message queues
- external object storage
- third-party APIs

should not automatically make an app unsupported if the application can use an existing externally supplied service.

The analyzer should distinguish:

```text
external credential/configuration required
```

from:

```text
platform must provision unsupported infrastructure
```

## Compatibility rules engine

The final verdict should come from explicit versioned rules.

Conceptually:

```text
if framework == NEXTJS
and runtime in supported_node_versions
and package_manager in supported_package_managers
and no hard_unsupported_requirement
and required_configuration_present:
    SUPPORTED
```

If configuration missing:

```text
NEEDS_CONFIGURATION
```

If a hard unsupported requirement exists:

```text
UNSUPPORTED
```

## Verdict precedence

Recommended precedence:

```text
1. Cannot safely analyse
2. Hard unsupported requirement
3. Ambiguous architecture requiring user input
4. Missing required configuration
5. Supported
```

This prevents a repository from being marked supported merely because one path looks valid while a hard blocker was also detected.

## Explainability

Every verdict must include human-readable evidence.

Example:

```text
Framework: Next.js 15
Detected from: package.json dependency `next`

Runtime: Node.js 22
Detected from: package.json engines.node

Package manager: pnpm
Detected from: pnpm-lock.yaml

Database: PostgreSQL likely required
Detected from: DATABASE_URL + Prisma provider=postgresql

Missing configuration:
- DATABASE_URL
- RESEND_API_KEY

Compatibility: NEEDS_CONFIGURATION
```

## Evidence model

Persist safe evidence records rather than arbitrary source dumps.

Example:

```text
{
  "rule": "framework.nextjs.dependency",
  "path": "package.json",
  "result": "matched",
  "value": "next@15.x"
}
```

Do not persist secrets or entire confidential files as evidence.

## Analyzer versioning

Every analysis result must store an analyzer version.

Example:

```text
analyzer_version = 0.1.0
```

If rules change, previous analyses remain historical facts.

A repository may be reanalysed with a newer analyzer version, producing a new analysis row.

## Determinism requirement

For the same:

```text
commit SHA
application root
analyzer version
```

the analyzer should produce the same deterministic result.

This is a core test invariant.

## AI-assisted analysis

AI is optional and secondary.

Potential future use:

- explain an unknown dependency
- classify ambiguous custom configuration
- generate human-friendly troubleshooting guidance

AI must not silently convert:

```text
UNSUPPORTED -> SUPPORTED
```

without a deterministic rule change or explicit human-reviewed exception policy.

## No code execution

The analyzer must not run:

- `npm install`
- package scripts
- builds
- shell commands from the repository
- arbitrary imported JavaScript

Static parsing only.

This keeps repository analysis separate from hostile-code execution risk.

## Parsing strategy

Prefer structured parsers over regex when structured formats exist.

Examples:

- JSON parser for package.json/tsconfig
- safe YAML parser when required
- Prisma schema parser or conservative text parser
- AST-based JavaScript/TypeScript environment-reference detection if justified

Regex may be used for bounded simple patterns but should not become the entire analyzer architecture.

## Resource limits

Analysis must be bounded by:

- maximum files inspected
- maximum bytes per file
- maximum cumulative bytes
- maximum parse time
- maximum AST/source complexity where applicable

If limits are exceeded:

```text
UNSUPPORTED or ANALYSIS_LIMIT_EXCEEDED
```

with clear explanation.

## Analysis caching

A completed analysis keyed by:

```text
application root + commit SHA + analyzer version
```

can be reused.

Do not rerun identical analysis on every page load.

## Security considerations

Repository content is hostile input.

Parsers must defend against:

- malformed JSON/YAML
- huge nesting
- encoding anomalies
- denial-of-service patterns
- malicious filenames/paths

Never interpolate repository content into shell commands.

## Initial V1 supported profile

The earliest compatibility profile should be deliberately narrow.

Target:

```text
Source: GitHub
Framework: Next.js
Runtime: supported Node.js LTS range
Package managers: npm, pnpm, yarn
Database: none, existing PostgreSQL, or managed PostgreSQL
Configuration: environment variables
Deployment shape: one web application
```

Generic Node support may follow immediately if architecture spike proves it equally reliable, but Next.js should be the first gold path.

## Example verdicts

### Example A - Supported static/simple Next.js app

```text
Framework: Next.js
Runtime: Node.js supported
Package manager: npm
Database: none
Required secrets: none
Unsupported requirements: none

Verdict: SUPPORTED
```

### Example B - DealOS-like app

```text
Framework: Next.js
Runtime: supported
Database: PostgreSQL/Supabase existing connection
Required configuration:
- database variables
- authentication variables
- third-party API keys

Verdict: NEEDS_CONFIGURATION
```

After configuration is supplied and validated:

```text
SUPPORTED
```

### Example C - Unsupported multi-service repo

```text
Detected:
- Next.js frontend
- Python FastAPI backend
- Redis dependency
- Docker Compose orchestration

Verdict: UNSUPPORTED
Reason: V1 supports one Next.js/Node application and does not support Python/Redis/Docker Compose workloads.
```

## Test corpus

The analyzer should be developed against a version-controlled repository corpus.

Include:

- simple Next.js app
- Next.js + PostgreSQL
- Next.js + existing Supabase
- missing env vars
- npm project
- pnpm project
- yarn project
- conflicting lockfiles
- unsupported Node version
- Python repo
- Docker Compose repo
- Redis-dependent repo
- monorepo ambiguity
- malformed package.json
- huge-file limit case
- native dependency cases

Our own DealUp, DealOS, and Vantage repositories eventually become high-value regression fixtures, but no platform-specific exceptions are allowed.

## Analyzer quality metrics

Track:

- false-supported rate
- false-unsupported rate
- percentage requiring manual configuration
- analysis duration
- analysis failures
- most common unsupported reasons
- most common missing variables

The most dangerous error is a false `SUPPORTED` verdict that later fails due to something the analyzer should have identified.

## Gate 5 - Analyzer Deterministic

Before passing Gate 5:

1. same revision + analyzer version produces same result
2. supported fixtures are consistently recognised
3. known unsupported fixtures are rejected
4. ambiguity does not become silent guessing
5. no repository code executes during analysis
6. environment-variable evidence is explainable
7. database detection is explainable
8. analysis is bounded against hostile input
9. analyzer output is persisted/versioned
10. compatibility verdict has human-readable reasons

## Decision

Small Software Cloud V1 will use a deterministic, versioned, static Application Analyzer focused first on Next.js/Node.js workloads.

The analyzer produces an explainable deployment plan input and rejects or pauses when requirements fall outside the validated compatibility boundary.

The next Node 02 document should define the Reliability Model: control-plane availability, durable execution, retries, reconciliation, health verification, latency budgets, failure containment, and recovery objectives.
