# Decision Record: Persist advisory context in conversation order

Status: implemented

## Problem

A runtime snapshot appended only to a temporary provider request changes position when the next tool result enters history. Even unchanged memory and diagnostics then occupy different input prefixes. Updating an earlier root message with tool-loop warnings causes another prefix rewrite. Retaining snapshots requires explicit current-state semantics so an old warning cannot masquerade as a current diagnosis.

## Decision

The Codex Session loop stores hidden non-root user messages for advisory observations. Each event records source identity, user permission role, Scope/workspace identity, format version, state and content revision. The first event carries complete source text; subsequent events carry complete changed sources. Sources distinguish present, explicitly cleared and temporarily unavailable states. System/developer workflow and permission instructions keep their existing authority.

The loop reserves the observation ID before the assistant ID, projects the staged event through the ordinary message converter, and commits its info and text atomically after prompt admission and before dispatch. Retry preparation compares durable source revisions. A content hash invalidates those revisions when a plugin changes the projected event text. Compaction re-emits sources whose events left the working set. Forks remap canonical task roots as well as parents. Other provider layouts omit these events from their temporary projection and continue supplying their current context snapshot, while durable history remains intact for a switch back to Codex.

Tool-loop planning prompts, repetition reminders, repetition-only permission prompts, repeated-error stopping and search-failure escalation are removed. Search transport, ordinary tool permissions, cancellation, size and content-quality checks remain. This supersedes [durable search protection](../../archived/architecture/2026-10-03-durable-root-search-guards.md). A session-scoped versioned migration retires known system-injected guard notices without matching user-authored quotations or rewriting rollout evidence. It runs on owner access, outside application startup history scans. Advisory format v1 uses existing message and part storage; old histories without observations receive a complete event at the next admitted Codex request.

Existing `doom_loop` permission entries remain parseable, but the loop no longer requests that synthetic permission. They do not authorize or deny ordinary tool capabilities.

Advisory observations remain outside contributor query selection and do not split Library experience trajectories. Library uses the existing synthetic-message-aware turn collection when extracting a completed request and its failure provenance, so intervening observations do not hide the assistant's work or become a new user intent.

## Alternatives considered

**A temporary tail snapshot.** It avoids history growth but cannot preserve the previous request prefix across tool continuations.

**A complete snapshot on every step.** It retains stable history positions but duplicates unchanged memory, instructions and environment data, increasing context and compaction pressure.

**An unchanged-context confirmation on every step.** Controlled replay did not distinguish its cache benefit from changed-source observations. It adds input and leaves more uncached tokens, so unchanged sources produce no new observation.

**Summarizing or freezing dynamic sources.** This reduces bytes by changing available information or current state, which does not satisfy the preservation requirement.

**Promoting advisory text to system authority.** This changes instruction precedence and does not address volatile higher-priority prefixes.

## Consequences

Append-only observations permit prefix reuse while retaining complete information and explicit latest-state semantics. Changed sources increase stored and model-visible history, so compaction remains necessary. Tool schema changes, plugin history transformations and mutable system/developer instructions can still invalidate a prefix. Cache hit ratios alone cannot justify the layout: comparisons must also measure uncached input, context growth, failure coverage, latency and task correctness. Private replay evidence stays outside repository documentation; deterministic provider, continuation, compaction, migration, restart and fork tests describe the public invariants.

In a user-shortened real-model evaluation, matched available validation requests across twelve held-out conversation families increased weighted cache reads from 20.42% to 73.23%, reduced uncached input by 66.23%, and increased total input by 0.40%. The family-bootstrap interval for the cache-rate difference was 42.47–60.24 percentage points. These are descriptive results for fixed historical trajectories under the tested Codex configuration, conditional on early termination and observed usage; they are not a guarantee for other models, providers or native trajectories. The complete first validation repetition independently supported the same selection. Unknown usage was retained as unknown. Full-snapshot accumulation exceeded the configured context limit and was rejected.

Rollback must retain stored observations while excluding them from the temporary provider projection and restoring the complete current tail snapshot. Reverting only the writer would leave historical observations without current-state updates. The loop-guard retirement migration is independent of the advisory layout and remains applied.
