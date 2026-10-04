# Decision Record: Bounded process windows and system event details

Status: implemented

## Problem

Long expanded execution groups consume the conversation height. Independent row and renderer spacing makes mixed tools and reasoning uneven. Agent deliveries can also be projected by metadata-only turn segments, duplicating a late message above its chronological owner. Large inline system cards interrupt the process narrative.

## Decision

Each continuous process group owns one bounded scrolling window. Its inner virtualizer retains the existing six-Part and body-byte chunk budgets, focus, selection and content leases. Public prose and final answers remain in the outer conversation. The window uses 320px and narrow-column 240px caps, further limited to 45% of the conversation viewport. Rows share 28px minimum height, 14px/20px text, 20px icon columns, 8px horizontal gaps and 2px vertical gaps.

Tools, reasoning, Agent deliveries and compaction join their canonical order within the same logical group. Only tool Parts contribute to its operation count. Metadata and footer segments cannot emit another segment's Agent delivery or compaction. Running compaction uses a compact status row; its animation respects reduced motion.

An event-first group uses the event's message identity, including before any body Part is hydrated. Canonical manual-compaction metadata also establishes a pending event before its request Parts load. Loading or replacing detail content cannot rename the group, and an unloaded preceding span cannot make the event depend on an earlier tool Part.

A manual compaction request owns a pending process event only until its canonical attempt arrives. The attempt replaces the request's presentation across running, completed, failed and empty outcomes, so segmented rendering cannot retain a request spinner after completion. Detached execution reconciliation reads effective transcript history, including rollback visibility, rather than the compacted model working set; compaction cannot remove a previous root's durable completion evidence.

Agent and compaction rows select the Session-owned execution detail panel with a discriminated event identity. The panel performs read-only generated SDK calls, preserves resolved content during refresh and failed refreshes, aborts replaced selections, and guards server, Scope, Session and message identity. Read failures stay local, retain structured diagnostic text and allow one explicit retry while pending. Exact Cortex task identity follows the [delivery identity decision](../architecture/2026-10-04-retain-cortex-delivery-task-identity.md). A reused child Session cannot replace the original result; missing evidence is explicit.

Local scrolling pauses following independently from the outer conversation. New content exposes an overlay latest control. Virtualizer offsets and bounded layout snapshots preserve reading through history prepend and reopening. Focused or selected inner rows retain their outer owner.

History search retains its target by message and Part identity while preceding summaries and bodies hydrate. Layout changes resolve the current outer row and local process owner again instead of reusing a captured virtual index. Corrections respect conversation scroll padding and stop immediately on wheel, touch, pointer or keyboard input; disposal and superseding navigation invalidate pending location work.

The implementation is [virtual conversation rows](../../../../apps/web/src/components/session/virtual-conversation-rows.tsx), [process viewport](../../../../packages/ui/src/components/process-viewport.tsx), [event rows](../../../../packages/ui/src/components/process-event-row.tsx) and [event details](../../../../apps/web/src/components/workspace/process-event-detail.tsx). This extends the [bounded rendering decision](../architecture/2026-10-03-bounded-conversation-process-rendering.md).

## Alternatives considered

**Render every expanded group directly in the conversation.** The number of operations determines message height and hides surrounding narrative.

**Put the entire turn, including prose and final answers, into one scrolling window.** Reading the answer would compete with process inspection, and the existing independently bounded bodies would lose their owners.

**Expand large system payloads inline.** This creates a second detailed presentation alongside execution inspection and causes more outer layout movement.

**Sort projected events again by timestamp or identifier.** Canonical ordering is already correct. The duplicate originates in segment ownership, so a second sort cannot remove it safely.

## Consequences

Process inspection uses nested scrolling and requires explicit keyboard, selection, anchor and motion verification. Bounded windows reduce the outer conversation height without loading full process bodies. Details remain lazy and selection stays explicit. Historical Agent notices without exact result evidence retain their original notification and source link.
