# Decision Record: Independent Session long-term and compaction summaries

Status: implemented

## Problem

A Session can contain unrelated task roots, completed discussions and later returns to earlier topics. Its compaction summary must hand off the current work while recursively carrying older history. A task-oriented handoff alone does not provide an independently maintained record of important conversation-wide conclusions, corrections and rejected alternatives. Putting that record in a workflow or Library would give it the wrong lifecycle and make ordinary Session behavior depend on optional products.

## Decision

Maintain an optional Session-owned long-term Markdown summary L alongside the existing compaction summary S. The experimental, live `session-long-term-memory` behavior defaults off, is declared by the existing Local Runtime foundation and is selected once for an invoke. Provided core declarations enter the same generated feature catalog as installable components, without fabricated installation metadata or optional-product dependencies. Without an explicit CLI plan, Agent Runtime reads saved preferences from the actually selected Host; an explicit plan remains authoritative.

Keep S's prepared-request, retry and coverage behavior in its current implementation. Compaction starts a separate `SessionLongTermMemory.update()` call concurrently and awaits both calls. They can use the same model but have independent retry and publication. Success on one side does not require or roll back success on the other. User cancellation reaches both; recording failures and hard storage errors propagate through compaction and native invoke instead of pretending that an unknown commit preserved old state. The L update entrypoint does not require compaction, but this integration does not add per-turn background inference or another workflow.

The L model returns only complete Markdown. With no meaningful change it reproduces the previous body exactly, including whitespace. The host compares complete strings rather than accepting JSON actions or unchanged markers. Body revision and reviewed-history progress are independent: unchanged Markdown still advances the checked source cursor. Progress carries a versioned digest of the reviewed prefix, so a missing anchor or changed older evidence invalidates L before rebuilding rather than silently trusting its old cursor. Header bookkeeping does not invalidate that proof; source-preserving pruning, fork and import verify and rebase it through their owners. Generation runs outside transactions; source, body and progress checks guard one atomic L publication.

Review effective original evidence after the last cursor, including history outside S's model working set. Exclude summaries and system bookkeeping. Restore retained tool output evidence and preserve native message and media projection. Segment oversized text without dropping characters; reject incomplete output and unavailable or indivisible evidence rather than inventing coverage. Use the existing model-capacity calculation and request the largest output allowance that fits the assembled segment and a complete rewrite. A full configured-output reservation must not reject an otherwise fitting old L; the fitting-group fallback uses the same request meter rather than a fixed fraction. Do not impose the unapproved fixed character ceiling or an additional half-window policy.

Inject the latest L through the existing budgeted advisory assembly before each model request. Ordinary providers use their late-system layout; Codex uses durable state-source updates. This allows the same root to receive a newly committed L after compaction. Storage, fork, rollback, import and export follow the [Session state reference](../../../architecture/session-and-messages.md#session-long-term-summary); L is not shared across independent Sessions implicitly.

## Alternatives considered

**Task working state instead of Session memory.** A current goal, TODO list or temporary execution state cannot represent unrelated completed topics and later revisits. It does not satisfy the conversation-wide requirement.

**Library or workflow-owned storage.** Library serves reusable cross-Session knowledge, while workflows have their own execution owners. Either placement changes the lifecycle and introduces dependencies that a Session summary does not need.

**One model response and one joint L/S commit.** A combined response couples output formats, retry and success. It changes the established S path and makes one failed update require repeating successful work. Independent calls preserve the existing compaction behavior and allow separate updates.

**JSON update actions or no-change sentinels.** These add a model-facing protocol for information the host already determines from string equality. They also blur the distinction between an unchanged body and newly reviewed evidence. Full Markdown plus separately persisted progress is sufficient.

**A fixed 65,536-character ceiling or a half-window reservation.** Neither value is an established product requirement or supported by workload measurements. Native model capacities and the existing request meter provide the relevant execution limits without an additional arbitrary quota.

## Consequences

Selected compactions incur an additional model call and L source validation. Parallel execution does not establish a latency, token-cost, cache-hit or recall-quality improvement. Incremental review avoids hydrating previously reviewed bodies, but still enumerates effective headers and canonical Part keys, revisions and existing execution facts; very large history performance requires separate measurement.

The complete L body is rewritten by the model, not patched by the host. Equivalent reformatted Markdown advances its body revision. Failed segments, stale candidates and cancellation cannot publish partial review progress, so a later update may repeat uncommitted model work. Missing original evidence leaves the previous L intact rather than silently treating derived or truncated text as original.

Raw transcript archives can restore content excluded by rollback. Such exports omit review progress when that restored source falls before the recorded cursor; import then discards L and rebuilds instead of skipping restored content. This preserves the original archive behavior without falsely claiming that imported history was already reviewed.

Feature disablement preserves dormant L. No startup backfill, automatic restart continuation, cross-Session collection or large-scale semantic benchmark is added. An assembled request that cannot fit the chosen model still fails explicitly rather than truncating its summary or unread history.

## References

- [LLM loop and compaction](../../../architecture/llm-loop.md#session-long-term-summary)
- [Session state](../../../architecture/session-and-messages.md#session-long-term-summary)
- [Feature lifecycle](../../../architecture/feature-lifecycle.md)
- [Storage and paths](../../../reference/storage-and-paths.md)
