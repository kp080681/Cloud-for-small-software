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

## Security review

`PROMPT-INJECTION-REVIEW.md` — item 10's adversarial audit of what the
current backend would and wouldn't expose to a calling agent. Confirms
status/diagnostic text is always from fixed lookup tables, README content
is never read anywhere, and the one genuinely unconstrained free-text field
in the system (`buildCommand`) was never in any tool's output — while
documenting one real, narrow residual channel (three `get_logs` evidence
keys that can carry attacker-chosen but structurally-bounded identifiers).
Enforced by `test/prompt-injection.test.mjs`, not just described in prose.

## What's still open (item 11, and a live implementation, not this one)

Items 8, 9, and 10 are now complete (OAuth auth, MCP rate limiting plus
destructive-operation unreachability, and this prompt-injection review).
What remains:

- The `deploy` tool's actual backing function doesn't exist yet — today,
  analyze/create and redeploy are two different functions with no single
  entry point that picks between them. Building that composition, wiring
  a real MCP protocol server around all five tool handlers, and having
  each handler call `verifyAccessToken` before doing anything, is the
  remaining implementation work this whole `mcp/` directory has been
  preparing for.
- A live adversarial test against that real implementation once it
  exists — this review's tests prove what the current backend *would*
  expose by source tracing; the genuine next step is deploying a real
  repo with a deliberately suggestive env var name and confirming a real
  calling agent doesn't act on it.
- Item 11: re-running Gate 12 criteria against the full merged scope
  before any self-serve or MCP-driven signup opens.
