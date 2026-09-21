# Node 15R.14 — Independent Adversarial Re-Review

Status: TWO INDEPENDENT PASSES COMPLETE, differently framed (tenant-boundary identity, then abuse/throughput). One reproducible defense-in-depth gap found and fixed on the first pass; one substantial, unfixed gap confirmed on the second (see Finding 4) that feeds directly into checklist item 3 rather than being patched here. No reproducible P0 blocking the current founder-operated controlled alpha remains from either pass, but Finding 4 should be treated as a hard precondition before any self-serve or MCP-driven signup opens.

Reviewer: Claude, given full repository access, with no prior conclusion supplied. Method: read production call paths directly, verify claimed controls against actual code rather than against the evidence packet's prose, and attempt to construct concrete cross-tenant scenarios rather than only checking that a helper function exists.

## Scope of this pass

1. The `customer-interface` application in full — never previously adversarially reviewed, since it was built after the Sept 5 review that produced the original P0/P1 findings.
2. A fresh look at the highest-stakes control-plane paths (app deletion, redeployment creation).
3. Spot-verification of previously claimed-complete controls (tenant-boundary assertions, provider mutation concurrency fencing) against their actual call sites, not their existence.

## Finding 1 — `create-redeployment.ts` had no independent tenant-boundary check [FIXED]

**Severity:** P1 (defense-in-depth gap with real cross-tenant impact if triggered incorrectly), verified reproducible from the repository.

**What was found:** the `ssc-control-plane-create-redeployment` Trigger.dev task accepted only `{ appId: string }` and fetched the app with `WHERE a.id=$1 AND a.deleted_at IS NULL` — no workspace scoping at all. Of the ten tenant-boundary assertion functions exported from `tenant-boundary.mjs`, four (`assertAppInWorkspace`, `assertDeploymentInWorkspace`, `assertDeploymentBelongsToApp`, `assertRuntimeBelongsToApp`) have zero production call sites anywhere in the codebase — this task called none of them.

**Why this mattered:** the task's only current caller (`control-plane/scripts/run-redeploy.mjs`, an operator CLI script) happens to resolve the app through `resolveAppTarget(db, { workspaceId, appId, slug })`, which is itself workspace-scoped — so no incident has occurred. But that safety existed entirely in the caller's discipline, not in the task itself. Any future caller (a new script, a manually-triggered Trigger.dev dashboard invocation, or a future MCP `deploy`/`redeploy` tool implementation) that passed a mismatched `appId` — whether by bug or operator error — would have redeployed a different tenant's app with no independent check catching it. This is exactly the class of risk 15R.1–15R.3 were meant to close everywhere.

**Fix applied:** added `workspaceId` to the task's payload type, scoped the fetch query to `WHERE a.id=$1 AND a.workspace_id=$2 AND a.deleted_at IS NULL` (matching the already-correct, already-proven pattern in `delete-app.ts`), and updated the one real caller to pass the `workspaceId` it already resolves. No other caller of this task exists in the repository; the customer-facing redeploy route (`.../redeploy/route.js`) uses a separate, already-verified code path (`redeployLiveCustomerApp`) and was unaffected.

**Verification performed:** confirmed via `grep` that `run-redeploy.mjs` is the only caller of `"ssc-control-plane-create-redeployment"` in the entire repository, and that the customer-interface redeploy route does not invoke it. No automated regression test exists for this file specifically — consistent with the rest of the `.ts` trigger tasks in this codebase, which rely on live-provider verification rather than unit tests, per the pattern already established in the 15R evidence packets. This is a real gap: a manual live-path re-verification of the redeploy flow (same style as the 15R.12A managed-database live activation evidence) is recommended before treating this fix as fully proven, not just code-reviewed.

## Finding 2 — four tenant-boundary assertion helpers remain unused [NOT YET RESOLVED]

**Severity:** informational / evidence-integrity, not itself an exploitable path.

`assertAppInWorkspace`, `assertDeploymentInWorkspace`, `assertDeploymentBelongsToApp`, and `assertRuntimeBelongsToApp` are exported, presumably unit-tested in isolation, and called from zero production files. The remediation graph's own acceptance criteria for 15R.3 state: "unused assertions are either intentionally documented as future/self-service controls or removed from claimed alpha evidence." Right now they are neither — they're implicitly counted toward the "tenant-boundary assertions are wired into production paths" claim in the 15R status table, which is only true for six of the ten.

**Recommendation, not yet actioned:** either (a) audit each of the four for a real call site that should be using them (the `create-redeployment.ts` fix above suggests at least `assertAppInWorkspace` has a legitimate home, though I chose direct SQL scoping there to match the established `delete-app.ts` convention instead), or (b) explicitly mark them in the evidence doc as reserved for future self-service surfaces and exclude them from the "wired" claim.

## Finding 3 — customer-interface surface (full re-check)

Re-confirms the finding from the earlier pass in this conversation, now folded into this formal record: every workspace/app/deployment-scoped route resolves through `getAuthorizedWorkspace` → `loadAuthorizedApp` → deployment-ownership checks; the GitHub App install flow independently re-verifies installation ownership against a live GitHub API call rather than trusting the redirect URL; error responses are code-only with no internal detail leakage. No reproducible P0 found in this layer.

## Finding 4 — no request-level rate limiting exists anywhere, with a real cross-tenant consequence

**Severity:** P1 for the current founder-operated alpha; becomes P0-equivalent the moment self-serve signup opens (see Workstream A in the accompanying roadmap).

**Method:** a second pass, deliberately framed around abuse/throughput rather than tenant identity, per the gate's instruction not to repeat the same attack class. Searched the entire `customer-interface` codebase for any rate-limiting, throttling, or per-identity request cap — found none. Every mutating API route (deployment start/retry, secret writes, repository selection, GitHub install) is reachable at whatever rate the caller's HTTP client can sustain, bounded only by the *active resource count* ceilings in `workspace-resource-policy.mjs` — which cap how many things can be alive at once, not how fast a caller can attempt, fail, and retry.

**Checked and ruled out as a separate concern:** workspace creation itself (`ensureInitialWorkspace`) is correctly idempotent per customer identity, guarded by a Postgres advisory lock against concurrent duplicate creation — this is not spammable and needed no fix.

**What is a real, currently-live exposure:**

- **Shared GitHub App token exhaustion is a cross-tenant denial-of-service, not just a per-workspace nuisance.** Repository analysis and env-var detection make real GitHub API calls (`getTree`, one `getBlob` per detectable file) using the platform's own GitHub App installation credentials — a resource shared across every workspace on the platform. One workspace repeatedly re-triggering analysis on a large repository, with nothing throttling how often it can do so, can burn through the App's GitHub API rate budget and degrade or block analysis for every other tenant. This is not hypothetical rate-limit math; it is the direct, predictable consequence of an unthrottled shared credential.
- **AWS KMS calls cost real money per invocation and are not gated by any resource-count check.** `saveCustomerAppSecret` encrypts through KMS on every call; the active-app/active-deployment ceilings do nothing to slow this down, since writing a secret is not itself a counted "active resource."
- **A stuck or buggy calling agent — human-driven today, but explicitly the intended MCP use case going forward — can loop on deployment start/retry far faster than a human would**, and since a `FAILED` deployment quickly exits the "active" count, the active-deployment ceiling does not meaningfully slow a fast retry loop; it only prevents many deployments being simultaneously *alive*, not many attempts happening per second.

**Confirmed not a gap, by design:** no webhook handler exists anywhere in the codebase, which initially looked like a Gate-4 evidence gap, but 15R.6's own evidence packet confirms Git auto-deploy is deliberately disconnected at the Vercel project level for V1 — redeploys are pull-based (an explicit customer/operator action), not push-triggered — so there is currently nothing for a webhook to do. This is consistent with the documented architecture, not an oversight.

**Not fixed in this pass, deliberately:** unlike Findings 1 and 3, this isn't a small surgical patch — it's the substance of checklist item 3 (per-workspace rate limits and provider-level resource ceilings) in the accompanying roadmap, which already has draft limits (deploys/hour, MCP calls/hour, etc.) worked out in the Containment & Onboarding Spec tab. Bolting on a rushed rate-limiter here risks conflicting with that already-scoped design rather than helping it. This finding is best read as concrete evidence for *why* that checklist item matters, not a signal to freelance a quick fix outside it.

- **Provider mutation concurrency fencing** (`provider-mutation-fencing.mjs`): `claimProviderCreateOperation` uses a real atomic compare-and-swap via `UPDATE ... WHERE status IN (...) AND provider_resource_id IS NULL` plus a `rowCount` check — legitimate protection against double-claiming under concurrent execution, not superficial.
- **App deletion** (`delete-app.ts`): fetch is workspace-scoped at the query itself, with a redundant `deletion.workspace_id !== payload.workspaceId` check before the destructive branch. This was the reference pattern used to fix Finding 1.
- **Tenant-boundary assertion logic itself** (the six functions that are used): genuine independent-value comparisons, not tautological self-checks.

## What this pass did not cover

This was one reviewer reading code and constructing scenarios by hand — it did not include live exploitation attempts, concurrent-request race testing beyond what's already unit-tested, rate-limiting/abuse behavior under load, or session-fixation edge cases in the Iron-sealed cookie implementation. The gate's own text calls for at least two independent adversarial reviewers; this is the first.

## Recommendation

Do not yet mark Gate 15R closed on the strength of these two passes alone — both were run by the same reviewer (me), and the gate's own text calls for genuinely independent reviewers, not just differently-framed attempts by one. Recommended before Gate 15R closes: (1) a real second reviewer or model, given no prior conclusion, repeating this exercise fresh; (2) a live re-verification of the redeploy path specifically, since Finding 1's fix has code review but no live-provider proof yet; (3) a decision on Finding 2's four unused assertions; (4) checklist item 3 (rate limits and resource ceilings) treated as a hard precondition before self-serve or MCP-driven signup, per Finding 4 — not merely a roadmap nice-to-have.
