# Utplava MCP tool contract

Locks the input/output shapes for the MCP server AI platforms will call during
deployment (checklist item 7, Workstream C). This is a schema-definition
deliverable — the server itself is not implemented yet (item 9), and OAuth-scoped
auth is not wired yet (item 8). Every schema here is machine-validated (see
`test/schemas.test.mjs`, run with `npm install && npm test` from this directory)
against realistic example payloads, not just hand-written and hoped-correct.

## Tools

| Tool | Purpose | Backing implementation |
| --- | --- | --- |
| [`deploy`](schemas/deploy.json) | Deploy a GitHub repo (create or redeploy, transparently) | Not yet composed — see the schema's `backedBy` note |
| [`get_status`](schemas/get_status.json) | Plain-language status of an app's latest deployment | `getCustomerDeploymentProgress` |
| [`get_logs`](schemas/get_logs.json) | Plain-language deployment timeline | `getCustomerDeploymentProgress`'s `events` |
| [`set_env`](schemas/set_env.json) | Set a config value already detected as needed | `saveCustomerAppSecret` |
| [`list_apps`](schemas/list_apps.json) | List apps in the authenticated workspace | `listWorkspaceApplications` |

## Design principles this contract encodes

- **Auth, not arguments, decides scope.** No tool takes a `workspaceId` or
  `customerId` parameter — scope comes entirely from the caller's OAuth
  token (item 8). `list_apps`'s test explicitly asserts a `workspaceId`
  input is rejected, so this can't silently regress.
- **`set_env` cannot invent new keys.** It only accepts a key already
  present in the app's detected requirements (`ENV_KEY_NOT_APPROVED`
  otherwise) — an agent can't be manipulated into exfiltrating an
  arbitrary secret name through this tool.
- **Plain language over raw internals, everywhere it reaches a human.**
  `get_status`'s `stage` and `get_logs`'s entry `title`s are the existing,
  already-tested `stageLabelForStatus` / `eventTitles` output (item 5) —
  this contract reuses that work rather than reinventing translation at
  the MCP boundary.
- **One sentence, one action, on failure.** `diagnostic` (`code`, `title`,
  `action`) is the same shape already used in the customer-facing UI's
  failure state — no stack traces, no raw provider error bodies.

## Deliberately excluded from this contract

`delete_app`, workspace creation or membership changes, billing, and any
other irreversible action. These stay behind the human-facing UI with
explicit confirmation. This isn't a gap to fill later — the destructive-name
test in `schemas.test.mjs` exists specifically so a future edit can't
casually add one of these without the test failing and forcing a deliberate
decision to remove that guard.

## What's still open (items 8–10, not this one)

- The `deploy` tool's actual backing function doesn't exist yet — today,
  analyze/create and redeploy are two different functions with no single
  entry point that picks between them.
- OAuth-scoped auth wiring (item 8).
- Per-tool rate limiting reusing `rate-limit.mjs` from item 3, and
  confirming destructive operations stay unreachable (item 9).
- Adversarial prompt-injection testing against a real implementation
  (item 10) — this contract's shapes make that testing possible, but
  don't substitute for actually doing it.
