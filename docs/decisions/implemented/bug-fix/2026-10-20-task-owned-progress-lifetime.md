# Decision Record: Derive progress lifetime from task state

Status: implemented

## Problem

The bottom progress label described canonical Todo/DAG completion while its lifetime followed Session execution. A new request could restore an unchanged completed graph, and ordinary idle execution could hide unfinished tasks. Selecting a completed view could also conceal unfinished work in the other view. Task settlement and execution activity are independent facts.

## Decision

The existing progress summary derives one header source: DAG attention first, then unfinished work, then the selected view. Expanded content retains the selected view and its counts. Counts are never summed across potentially duplicate Todo and DAG lists.

The existing panel owns the local receipt phase and one timer. Unfinished accepted task state admits or restores the entry independently of runtime activity. Only an admitted entry receives a completion or cancellation receipt lasting 1.6 seconds plus the 180ms exit; reduced motion omits the exit. Historical completed snapshots stay hidden. New or reopened unfinished work cancels either exit phase. Removal hides immediately. Session reset and lifetime transitions share one effect so navigation cannot reset an already admitted entry afterward.

Completion does not close expanded reading. Explicit collapse starts the receipt; editor or workflow suppression still collapses through its existing focus owner and cannot replay a dismissed receipt. Runtime working, waiting, paused and unknown states affect descriptive labels only. Related child execution uses existing Session and Cortex projections; task data remains canonical. Connection loss does not invalidate already accepted task completion.

This supersedes the execution-owned receipt and readiness rules in [bottom activity controls](2026-10-04-session-bottom-activity-controls.md) and [persistent task attention](2026-10-16-persistent-task-attention.md), while retaining their layout, focus, graph retention and canonical attention decisions. No backend field, persistent flag, dismissal cache, history scan, request or subscription is added.

## Alternatives considered

**Continue using execution end as task settlement.** Unrelated requests restore old completion, while an idle runtime can conceal unfinished tasks.

**Persist a dismissed graph identity or clear completed task data.** Either adds a second authority for visibility or removes canonical history merely to dismiss a presentation. The existing local phase already distinguishes an admitted completion from completed history.

**Close expanded details at completion.** It interrupts reading and can remove a focused control without an explicit reader action. Existing focus restoration remains responsible for actual closure or removal.

## Consequences

Unfinished state remains visible until its owner completes, cancels, removes or corrects it; idle execution does not silently repair stale task statuses. Task activity labels remain conservative when synchronization or connectivity is unknown. Browser regression coverage exercises historical completion, new execution, cross-tab priority, sparse runtime and child activity, final-task settlement, cancellation, reading, both exit phases, navigation, suppression, reduced motion and stable Composer geometry. Pure summary coverage isolates source priority and keeps task counts independent.
