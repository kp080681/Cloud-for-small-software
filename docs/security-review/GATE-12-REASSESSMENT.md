# Gate 12 Re-Assessment — Vibe-Coding/MCP Merged Scope (Checklist Item 11)

Status: assessment complete. **Gate 12 is not yet met.** Real, substantial
progress happened this session — nine of the eleven roadmap checklist items
shipped with real code and real tests — but this document's job is to say
plainly what's still missing, not to round up.

## Scope

The original `MASTER-GRAPH.md` defines Gate 12 ("External Alpha Ready") as
21 requirements across five categories, written for invited, founder-vetted
users. This session's roadmap merges that with three new workstreams (A:
abuse containment, B: zero-config onboarding, C: MCP server) needed for
self-serve, agent-driven signup — a materially higher bar than the original
gate assumed. This assessment covers both: the original 21, re-checked
against what this session actually touched or left untouched, plus the new
workstream-specific criteria the merged gate now implies.

Verdict key: **MET** (real evidence, live or as close to live as this
environment allows) · **BUILT, NOT LIVE-VERIFIED** (real code, real tests,
but the honest gap already flagged item-by-item all session: no live
database or provider access here) · **PARTIAL** · **NOT MET** · **UNCHANGED**
(this session didn't touch it; carries whatever its prior status was).

## Original Gate 12 — Security requirements

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Customer workload separated from control plane | UNCHANGED | Pre-existing architecture; not touched this session |
| Tenant boundaries verified | PARTIAL | Two adversarial passes this session (item 2) found and fixed a real gap (`create-redeployment.ts`); MCP auth (item 8) reuses the same verified boundary code. But the gate's own bar is independent verification, and both passes were me — genuinely not closed |
| Secrets encrypted | UNCHANGED | KMS envelope encryption, pre-existing, not touched |
| Least-privilege credentials | UNCHANGED | Not specifically re-audited this session |
| Resource limits enforced by underlying infrastructure | BUILT, NOT LIVE-VERIFIED | Item 3's rate limits are real and tested at the unit level; item 3's own log already flagged this gap explicitly |
| Safe deletion verified | PARTIAL | Re-confirmed sound on fresh inspection during item 2's audit; not independently re-verified beyond that |
| Security review completed | **NOT MET** | Stated plainly in item 2's own write-up: two passes, same reviewer, gate's own text calls for a genuinely separate one |

## Original Gate 12 — Reliability requirements

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Repeatable deployment tests | PARTIAL | Hundreds of new unit tests shipped this session; no live, repeated real-deployment drill run (no live environment here) |
| Failed operations recover safely | PARTIAL | Item 6 (silent retry) and item 4 (auto-pause) both strengthen this concretely; broader recovery claims from prior work not re-verified today |
| Provider failures do not corrupt control-plane state | UNCHANGED | Not specifically re-audited; item 6's retry wrapper was deliberately scoped not to change existing failure-recording behavior |
| Retries are idempotent | PARTIAL | Item 6's retry is idempotent by construction; provider-mutation-fencing re-confirmed sound in item 2's audit; no live stress test |
| State-machine integrity tested | UNCHANGED | Not re-tested live this session |

## Original Gate 12 — Performance requirements

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Control plane responsive | UNCHANGED | Not touched this session |
| No unnecessary runtime proxy | UNCHANGED | Not touched this session |
| Platform-added latency negligible | UNCHANGED | Not touched this session |
| Slow infrastructure operations asynchronous | UNCHANGED | Not touched this session |

## Original Gate 12 — Operational requirements

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Deployment logs available | MET (strengthened) | Item 5's plain-language event titles/diagnostics are a genuine improvement over the prior jargon-heavy state |
| Runtime failures visible where feasible | MET (strengthened) | Same basis as above |
| Audit trail complete | UNCHANGED | Not touched this session |
| Infrastructure resources traceable | UNCHANGED | Not touched this session |
| Emergency disable/delete mechanism works | PARTIAL | Item 4 added a genuinely new mechanism (auto-pause + `resume-app.mjs`); not live-verified |

## Original Gate 12 — Recovery requirements

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Backup process tested | UNCHANGED | Not touched this session; relies on prior 15R/18 evidence |
| Restore process tested | UNCHANGED | Not touched this session |
| Control-plane recovery tested | UNCHANGED | Not touched this session |

## New: Workstream A (self-serve abuse containment)

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Per-workspace rate limits | BUILT, NOT LIVE-VERIFIED | Item 3 |
| Automatic anomaly-based suspension | BUILT, NOT LIVE-VERIFIED | Item 4 |
| Hostile-source-code-by-default assumption | UNCHANGED | Covered by prior 15R work (SSRF/source-boundary protections), not this session's scope |

## New: Workstream B (zero-config onboarding)

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Plain-language copy, no raw jargon | MET | Item 5, verified via `next build` and 6 new tests |
| Self-heal before asking human to debug | BUILT, NOT LIVE-VERIFIED | Item 6 |
| Remove up-front questions with sensible defaults | PARTIAL | Item 5 fixed misleading/dead UI but did not rebuild the onboarding flow's actual question set — that was never this session's scope |
| **Generous, ungated free tier with a hard ceiling** | **NOT MET** | The hard-ceiling half is done (items 3–4); the actual free-tier definition and billing-free access policy was never defined or built this session — this is a real, unaddressed gap, not just unverified |

## New: Workstream C (MCP server)

| Requirement | Verdict | Basis |
| --- | --- | --- |
| OAuth-scoped auth | MET | Item 8, thoroughly tested including a real RFC 7636 interop test |
| Narrow tool surface, destructive ops excluded | MET | Locked (item 7) and proven unreachable by filesystem-discovery tests (item 9) |
| Prompt-injection defenses | MET (as an audit) | Item 10 — real source-tracing, one narrow residual channel documented and tested as a regression gate |
| **A working MCP server** | **NOT MET** | This was never in scope for items 7–10 by design, and is stated as such repeatedly in this session's own docs. `deploy`'s actual backing function doesn't exist as one composed entry point yet. There is no protocol-level server dispatching tool calls at all |

## Overall verdict

**Gate 12 is not met**, and the two things actually blocking it are not
subtle: (1) there is no live-verification of anything built this session,
because this environment has no live database or provider access — every
"BUILT, NOT LIVE-VERIFIED" row above needs a real run against a real
workspace before it can honestly move to MET; and (2) the MCP server itself
doesn't exist as running code yet — schemas, auth, and safety audits are
real and locked, but nothing dispatches an actual tool call today.

Everything else genuinely moved forward. Going into this session, most of
Workstreams A and C didn't exist in any form; several were dormant bugs
masquerading as working features (Node 04.17's `required: false` default,
the unused `retryableNow` flag). That gap is closed. What's left is real
work, not busywork — but it's real work, and this document exists so
nobody mistakes nine shipped checklist items for an open gate.

## What would actually close Gate 12 next

1. Run every "BUILT, NOT LIVE-VERIFIED" item against a real deployment once
   — the specific tests are already named in each item's own progress-log
   entry (trigger the 31st analysis call, pause a real app after 3 real
   failures, etc.).
2. A genuinely independent second reviewer for 15R.14 (item 2's own
   unresolved item).
3. Define the actual free-tier limits and billing-free access policy —
   currently just "the hard ceiling exists," not "here is the tier."
4. Build the real MCP server: compose `deploy`'s missing entry point, wire
   a protocol dispatcher that calls `verifyAccessToken` before each tool,
   and run the live prompt-injection test item 10's own write-up
   specifies (a real repo with a suggestively-named env var, against a
   real calling agent).
