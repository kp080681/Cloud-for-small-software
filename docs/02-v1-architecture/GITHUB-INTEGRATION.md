# Node 02 - V1 GitHub Integration Specification

## Purpose

This document defines how Small Software Cloud V1 connects to GitHub, accesses repositories, resolves immutable revisions, receives source-change events, and preserves least-privilege access.

The governing principle is:

> Ask GitHub for the minimum access required to analyse and deploy supported repositories.

## Integration model

V1 should use a GitHub App rather than asking customers for broad personal access tokens.

A GitHub App gives the platform installation-scoped repository access, explicit permissions, installation-level repository selection, short-lived installation access tokens, and webhook support.

## Installation flow

Conceptual flow:

```text
User clicks Connect GitHub
  -> redirect to GitHub App installation
  -> user chooses account/organisation
  -> user chooses all or selected repositories
  -> GitHub completes installation
  -> platform receives installation ID
  -> platform stores installation metadata
  -> platform lists only repositories accessible to that installation
```

The platform should not assume access to repositories outside the installation scope.

## Recommended V1 repository permissions

Start with the minimum required set.

### Contents: Read-only

Required for source inspection and reading repository files.

Used for:

- package.json
- lockfiles
- framework configuration
- selected source/config files
- repository tree inspection
- deployment source access where provider architecture requires it

The platform should not request Contents: Write for V1.

### Metadata: Read-only

Repository metadata access is required for repository identity and basic repository information.

GitHub grants metadata access as part of normal GitHub App repository access semantics.

### Other repository permissions

Default to no access unless implementation testing demonstrates a specific required endpoint.

V1 should not request write permissions for:

- Issues
- Pull requests
- Actions
- Checks
- Deployments
- Administration
- Webhooks

unless a later feature explicitly requires them.

GitHub App-level webhook subscriptions should be preferred over creating individual repository webhooks ourselves.

## Why no repository write access

Small Software Cloud V1 does not need to modify customer source code.

It should not:

- commit configuration files
- edit workflows
- push branches
- create deployment commits
- write secrets into repositories

This materially reduces blast radius.

## Installation access tokens

The platform authenticates GitHub API calls using installation access tokens generated for the relevant GitHub App installation.

Installation tokens are short-lived and should be generated when needed rather than persisted as permanent credentials.

Do not write logic that assumes a fixed token length or token format.

## GitHub App private credential

The GitHub App private key or equivalent app credential is a control-plane integration credential.

It must:

- remain outside customer runtimes
- remain outside queue payloads
- be stored in platform secret infrastructure
- be available only to the component that creates installation authentication tokens

## Repository selection

The user should see only repositories exposed by the GitHub App installation.

Store:

```text
provider_repository_id
full_name
owner
name
default_branch
is_private
installation_id
```

Repository access must be revalidated before sensitive operations because users can later change GitHub App installation access.

## Repository access changes

Customers may:

- remove a repository from the installation
- uninstall the GitHub App
- change organisation policy
- transfer/rename a repository

The control plane must treat GitHub access as revocable.

If access disappears:

- existing live application may continue running
- new analysis/deployment from GitHub must stop
- UI should show source connection needs attention
- do not delete live infrastructure automatically merely because GitHub access was removed

## Source revision resolution

Branches are mutable pointers.

Therefore:

```text
main
```

must be resolved to:

```text
commit SHA
```

before analysis or deployment.

Persist the immutable revision.

All file reads for one analysis must use the same commit SHA.

Do not mix files fetched from a moving branch reference during analysis.

## Source retrieval strategy

V1 should retrieve only what the analyzer needs.

Prefer targeted reads such as:

- root tree/project tree metadata
- package.json
- package-lock.json / pnpm-lock.yaml / yarn.lock
- next.config.*
- tsconfig.json where relevant
- .nvmrc / runtime declarations
- env example files
- selected source files needed for deterministic environment-variable detection

Avoid downloading large repository history unless later architecture proves full clone is simpler and safe.

## Repository size protection

The source integration must enforce limits.

Examples:

- maximum tree entries analysed
- maximum individual file size read into analyzer
- maximum cumulative source bytes inspected
- skip known binary/generated directories

Potential skipped paths:

```text
node_modules
.next
dist
build
coverage
.git
large binary assets
```

The exact limits are technology decisions to be measured during the architecture spike.

## Submodules and Git LFS

Do not silently claim support in earliest V1.

If repository analysis detects unsupported source acquisition requirements such as critical submodules or Git LFS dependencies that our deployment path cannot correctly reproduce, return a clear compatibility failure.

Support can be added later based on demand.

## Monorepos

Monorepos are common enough that the schema should not prevent future support, but earliest V1 should remain conservative.

A repository may eventually have:

```text
root_directory
```

for an application.

If V1 supports monorepos, it should only do so with an explicitly selected app root and deterministic build context.

If not validated, mark complex monorepo layouts unsupported rather than guessing.

## Webhook endpoint

GitHub App webhooks should terminate at a dedicated control-plane endpoint.

Conceptual route:

```text
POST /webhooks/github
```

The handler must receive the raw request body so signature validation occurs before body transformation.

## Webhook signature validation

Every webhook delivery must be authenticated using the configured webhook secret and GitHub's `X-Hub-Signature-256` header.

Validation rules:

1. read raw request body
2. calculate HMAC-SHA256 using webhook secret
3. compare expected and received signatures using constant-time comparison
4. reject missing/invalid signatures
5. parse the payload only after verification

The webhook secret is a platform integration secret and follows the Secrets Architecture rules.

## Webhook event scope

Subscribe only to events required by V1.

Likely minimum events:

### push

Used to detect changes to a configured production branch.

V1 behaviour should initially be conservative:

```text
push to configured branch
  -> record new available revision
  -> optionally analyse
  -> show New commit available
```

Automatic production deployment should not be mandatory in earliest alpha.

### installation

Used to track GitHub App installation lifecycle.

### installation_repositories

Used to track repositories added to or removed from an existing installation.

Additional events should be subscribed only when required.

## Webhook delivery identity and deduplication

GitHub deliveries may be retried.

Persist a stable delivery identifier when supplied by GitHub, such as the delivery ID header.

Conceptual table fields:

```text
provider = github
provider_delivery_id
provider_event_type
installation_id
received_at
processed_at
status
```

Constraint:

```text
UNIQUE(provider, provider_delivery_id)
```

Duplicate delivery must not create duplicate deployments or duplicated irreversible actions.

## Webhook processing architecture

The webhook HTTP endpoint should do minimal work.

Recommended flow:

```text
receive
  -> verify signature
  -> extract delivery ID/event type
  -> persist webhook receipt
  -> enqueue processing
  -> return success promptly
```

Long-running analysis or deployment logic belongs in the worker.

## Push handling

For a push to an application production branch:

1. verify repository belongs to an active application
2. read `after` commit SHA from verified webhook payload
3. persist source revision if new
4. append source-update event
5. enqueue analysis if desired by V1 policy
6. expose new revision in UI

Do not trust repository name alone; resolve using stable provider repository ID and installation context.

## Automatic deployments

Earliest V1 default should be manual deployment after a new commit.

Example UI:

```text
New commit available
abc1234 - Fix reporting workflow

Deploy
```

Later configuration may support:

```text
Auto-deploy pushes to main
```

Automatic deployment should be explicit per application.

## Installation uninstall flow

When GitHub reports installation deletion/uninstall:

- mark installation DISCONNECTED
- mark linked repositories SOURCE_UNAVAILABLE or equivalent
- prevent new source reads
- preserve application/deployment history
- preserve live workloads
- surface reconnect action

Do not erase audit/history because source access was revoked.

## Repository removal flow

If one repository is removed from installation access:

- mark repository access unavailable
- stop new deployments from that repository
- leave unrelated repositories/applications unaffected

## Repository rename/transfer

Provider repository ID is the stable primary external identity.

Repository `full_name` is display metadata and may change.

Webhook/API reconciliation should update owner/name/full_name when provider repository ID remains the same.

## GitHub API rate limits

The adapter must respect rate limits and avoid wasteful repeated source reads.

Strategies:

- cache immutable commit-level reads where safe
- do not refetch completed analysis inputs unnecessarily
- use worker rescheduling when rate-limited
- normalize retry/reset metadata through provider interface

## Caching rule

Content at an immutable commit SHA can be cached safely according to retention policy because that revision cannot change.

Branch-head lookups must remain refreshable.

## GitHub source security

Repository contents are untrusted input.

Analysis must not execute repository code merely to understand it.

Do not run:

```text
npm install
postinstall scripts
project build scripts
repository shell scripts
```

inside the control-plane analyzer process.

Static analysis comes first.

Execution occurs only later inside the selected isolated build/runtime provider path.

## Unsafe file handling

Analyzer file reads must defend against:

- huge files
- binary files
- crafted encodings
- pathological package manifests
- excessive tree depth
- malicious source designed to exhaust analysis resources

Apply strict size/time limits.

## Private repository privacy

Repository contents are customer confidential data.

V1 should avoid retaining arbitrary source files in the control-plane database.

Persist only what is required for product operation, such as:

- source revision metadata
- analysis result
- compatibility evidence summaries
- hashes/paths where useful

Transient source content should be discarded after analysis unless a later architecture decision explicitly requires retention.

## Source logging policy

Do not dump repository file contents into logs.

Errors should reference safe paths and classifications.

Good:

```text
Unable to parse package.json at commit abc123.
```

Bad:

```text
Full package.json payload: ...
```

## GitHub disconnect vs application delete

These are separate concepts.

Disconnecting GitHub means:

```text
stop source access
```

Deleting an application means:

```text
execute application resource lifecycle deletion
```

Never conflate the two.

## V1 GitHub permission target

Initial target:

```text
Repository permissions:
- Contents: Read-only
- Metadata: Read-only / implicit repository metadata access

Webhook subscriptions:
- push
- installation
- installation_repositories

Account / organisation permissions:
- none unless later implementation proves necessary
```

Before creating the production GitHub App, validate every endpoint used by the architecture spike against GitHub's current permission documentation and reduce permissions where possible.

## Testing requirements

Before Gate 4 - Source Pipeline Reliable, test:

1. install app on personal account
2. install app on organisation test account where possible
3. selected-repository installation
4. all-repositories installation
5. list only authorised repositories
6. read private supported repository
7. resolve branch to commit SHA
8. read all analysis inputs from pinned SHA
9. valid webhook signature accepted
10. invalid webhook signature rejected
11. duplicate webhook delivery safe
12. repository removed from installation
13. app installation uninstalled
14. repository renamed
15. GitHub API rate limit handling
16. large/malicious file limits
17. no repository write capability

## Quality gate

GitHub integration is acceptable for V1 only when:

- no personal access token is required from the customer
- repository access is installation scoped
- repository write access is not requested
- exact commit SHA pins every deployment
- webhook signatures are verified before parsing/processing
- duplicate webhook deliveries are safe
- source access revocation does not crash or delete live workloads
- arbitrary repository code is not executed by the analyzer
- private source contents are not unnecessarily persisted
- permission requirements are documented and justified

## Decision

Small Software Cloud V1 will use a least-privilege GitHub App integration with read-only repository source access and a minimal webhook subscription set.

GitHub provides source and events; the control plane owns repository/application association, immutable revision identity, analysis lifecycle, and deployment intent.

The next Node 02 document should define the Application Analyzer Specification: exact detection rules for Next.js, Node.js, package managers, environment variables, PostgreSQL requirements, compatibility verdicts, and unsupported workload handling.
