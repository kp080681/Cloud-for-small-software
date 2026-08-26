# Spike F Results — GitHub App Integration

**Date:** 2026-08-26  
**Result:** PASS

## Objective

Prove that Small Software Cloud can connect to GitHub using a GitHub App rather than a broad personal access token, obtain installation-scoped repository access, and inspect a selected private repository with minimal permissions.

## GitHub App configuration

The spike used a dedicated GitHub App configured with:

- Webhooks: disabled for this spike
- Repository permission: Contents — Read-only
- Organization permissions: none
- Account permissions: none
- Enterprise permissions: none
- Installation availability: restricted to the owner's account during the architecture spike
- Repository installation: Only selected repositories

The app was installed on exactly one repository:

`kp080681/Cloud-for-small-software`

## Authentication model proven

Two different credentials are deliberately used for two different GitHub API boundaries:

```text
GitHub App private key
        |
        v
Short-lived App JWT
        |
        +--> App-level API
        |      - read installation metadata
        |
        v
Installation access token
        |
        +--> Installation/repository API
               - list accessible repositories
               - read repository metadata
               - resolve default branch
               - resolve branch SHA
               - read repository contents
```

The App JWT and installation token are short-lived credentials generated from the GitHub App identity rather than permanent broad repository credentials.

## Observed result

The final run returned:

```json
{
  "result": "SPIKE_F_PASS",
  "appAuthentication": true,
  "installationAuthentication": true,
  "installationId": 156659108,
  "installationAccount": "kp080681",
  "repositoryCount": 1,
  "repository": "kp080681/Cloud-for-small-software",
  "privateRepository": true,
  "defaultBranch": "main",
  "sha": "de6df7815ae356ba20b4e50396a591466cab1725",
  "rootReadable": true,
  "packageJsonPresent": false,
  "packageJsonReadable": false,
  "installationTokenPrinted": false,
  "appJwtPrinted": false,
  "privateKeyPrinted": false
}
```

`packageJsonPresent: false` is expected for this repository because there is no package.json at the repository root. The important proof is that the root contents were successfully read through the installation-scoped identity.

## Security properties demonstrated

### Repository scope is controlled by GitHub installation

The installation reported exactly one accessible repository. Small Software Cloud therefore does not require blanket access to all repositories belonging to a user.

### Private repositories are supported

The selected test repository is private and was successfully inspected using the installation token.

### Read-only permission is sufficient for source inspection

The spike required only GitHub repository `Contents: Read-only` permission. No write permission was needed to discover repository contents, resolve the default branch, or obtain the source SHA.

### Sensitive credentials are not printed

The spike deliberately does not print:

- GitHub App private key
- App JWT
- installation access token

The private key remains outside source control.

## Problems encountered

### Windows clock was not synchronized

The local Windows host initially reported:

`Leap Indicator: 3 (not synchronized)`

GitHub App JWTs are time-sensitive. The Windows time service was resynchronized before continuing.

### Incorrect clock-skew experiment

A temporary `timeDifference` adjustment caused GitHub to reject the JWT because its expiration was too far in the future. The change was reverted.

### Incorrect API credential boundary in the spike code

The initial implementation created an installation access token and then used that token for:

`GET /app/installations/{installation_id}`

That endpoint is an App-level endpoint and expects a GitHub App JWT. GitHub therefore attempted to interpret the installation token as a JWT and returned:

`A JSON web token could not be decoded`

The implementation was corrected to use two Octokit clients:

- App JWT client for App-level installation metadata
- installation-token client for repository access

After this correction the spike passed.

## Implementation

Spike implementation lives under:

`spikes/06-github-app/`

Key files:

- `run-spike-f.mjs`
- `package.json`

## What this spike proves

Small Software Cloud can use the GitHub App model required for the V1 product flow:

```text
User installs GitHub App
→ selects permitted repositories
→ platform obtains installation-scoped authentication
→ platform lists permitted repositories
→ platform selects a repository
→ platform reads source metadata/content
→ platform resolves the exact commit SHA for deployment
```

This is materially safer than asking users for broad, long-lived personal access tokens.

## What this spike does NOT yet prove

A PASS does not complete the customer-facing GitHub integration. Future product work still needs:

- public/multi-account GitHub App installation flow
- callback/setup flow in the Small Software Cloud control plane
- persistence of installation/account/repository mappings
- authorization tying installations to Small Software Cloud workspaces
- webhook handling for repository changes and installation lifecycle events
- installation suspension/deletion handling
- private-key production storage/rotation strategy
- organization installations and organization policy edge cases
- repository selection UX
- rate-limit and GitHub outage handling
- security review of the complete GitHub/control-plane boundary

## Decision

**SPIKE F PASS**

Use a GitHub App with installation-scoped access as the V1 GitHub integration architecture.

Do not use user-supplied personal access tokens as the normal product authentication model.

## Architecture spike status

```text
Spike A  Runtime provisioning        PASS
Spike B  Reconciliation/failures     PASS
Spike C  PostgreSQL provisioning     PASS
Spike D  Durable execution           PASS
Spike E  KMS secret management       PASS
Spike F  GitHub App integration      PASS
```

The core infrastructure assumptions needed to begin assembling the first integrated Small Software Cloud control-plane flow have now been validated against real provider APIs.
