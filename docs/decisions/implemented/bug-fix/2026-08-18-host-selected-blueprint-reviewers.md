# Decision Record: Host-selected Blueprint reviewers

Status: implemented

## Problem

A production BlueprintLoop failed with `review_terminal_tool_missing` after the audit reviewer never started. The Blueprint note carried `auditAgent: "reviewer"` — a user-defined agent with no model configured — so the Cortex reviewer task failed instantly with `No model configured for agent reviewer`. The failure was misclassified as "reviewer ended without a terminal review tool", which burned two recovery retries against the same broken launch and reported a misleading error.

The design intent is that workflow reviewers are host-selected: BlueprintLoop audits with the built-in `supervisor` and Light Loop with `lightloop-reviewer`. However, the model-facing `note_write` tool still exposed an `auditAgent` parameter (introduced in `1f7f1e52d`, retained when `8717a7c03` removed the execution-agent parameter), so a Plan/Lattice agent could write any agent name onto a Blueprint note, and `resolveBlueprintAuditAgent` accepted any known agent name without checking whether it was a primary, hidden, or host-owned reviewer.

## Decision

Close the model-facing audit-agent entry point and fail reviewer launch errors with the real cause:

- `note_write` no longer exposes an `auditAgent` parameter. Legacy inputs carrying that field are ignored, and the stored `auditAgent` metadata on existing Blueprint notes is preserved as inert legacy data (the same compatibility strategy used for `defaultAgent`). `note_read` always reports `Audit Agent: supervisor`.
- `BlueprintLoopService.resolveBlueprintAuditAgent` always resolves to `"supervisor"`. Non-plugin BlueprintLoops therefore snapshot `supervisor` as their audit agent. Plugin Protocol 5 `blueprint.start` keeps its explicit, validated `auditAgent` request path unchanged.
- Cortex marks tasks that fail before their first model turn with a durable `launchFailure` flag on the session's cortex delegation record. BlueprintLoop and Light Loop continuation both check this flag first: a launch-failed reviewer fails the workflow immediately with `reviewer_launch_failed: <original error>` without consuming the terminal-tool recovery budget. A synchronous prepare/start failure in the BlueprintLoop continuation is also caught and fails the loop with the real error instead of leaving it stuck in `auditing`.

## Alternatives considered

- **Delete the stored `auditAgent` field and write a note migration** — rejected: it would require a note-domain migration plus SDK/OpenAPI regeneration for data that is inert once the resolver ignores it; preserving the field matches the existing `defaultAgent` compatibility strategy.
- **Keep reading the note but whitelist the resolved agent to `supervisor`** — rejected: behaviorally equivalent to a constant resolution but retains a parsing path with no consumers; a constant is the simpler, single implementation.
- **Restrict the REST note API from writing `auditAgent`** — rejected: the resolver now ignores the field, so writes are behaviorally inert; tightening the REST contract would add OpenAPI churn for no behavioral gain.

## Consequences

User-owned BlueprintLoops can no longer be steered onto an unconfigured or non-host reviewer through note metadata; the audit reviewer is `supervisor` by construction. The stored `auditAgent` field remains readable as legacy metadata but has no effect on loop resolution. Reviewer launch failures now surface the real error (`reviewer_launch_failed`) immediately instead of spending two doomed recovery turns and reporting `review_terminal_tool_missing`. Plugin-owned Blueprints and plugin Light Loop review-agent selection are unaffected.
