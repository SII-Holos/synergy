# Decision Record: Keep Loop state visible through independent review

Status: implemented

## Problem

A bound Blueprint could enable submission without displaying its title or execution state. Light Loop controls did not distinguish review or requested changes, and compact Composer styles hid their labels. Detached metadata and terminal lookups could retain a row after its Session binding cleared. Draft selections could also appear bound, while canonical terminal metadata could hide a row before the Session binding cleared. Pure slot-selection tests did not establish what the Composer rendered.

## Decision

The Composer presents Session-bound Light Loop and BlueprintLoop through one compact row at the bottom of its pending-message stack, outside the editor. The row represents an established Session binding, not draft intent, independently cached execution state or a history of Loop outcomes. Combining those signals makes selected work appear started and lets event arrival order change whether a bound Loop is visible. The [Web product rule](../../../../apps/web/PRODUCT.md) defines the strict binding-only visibility rule for both Loop types.

Queue and Loop rows share surface geometry and labeled icon actions. The row's node and geometry survive metadata and stage changes while the Session remains bound, including a canonical terminal result arriving before the Session update. The goal editor and cancellation are direct actions as the recorded state permits; review reasons and related review sessions stay behind an information action. Existing pause and continue controls retain their meanings. Async edits and actions stay scoped to their captured owner. Clearing the binding removes the entire row and closes its open details dialog by its specific ID, without closing unrelated dialogs.

Row projection consumes only `Session.blueprint.loopID` or `Session.workflow.kind === "lightloop"`. Matching canonical metadata supplies labels and controls but cannot create or remove a row. Draft Blueprint and workflow selections remain separate next-send state and never establish a row by themselves. A paused, interrupted or idle Session keeps its row while bound; canonical terminal metadata also leaves it mounted until the binding clears. The Composer performs no historical Loop-result lookup or Light Loop terminal query, and no failed, unavailable or resolving result remains as a row after unbinding. Session idle, assistant-turn completion and reviewer-task completion do not establish Loop completion or approval.

Snapshot reads validate the currently bound Blueprint. Pending and failed metadata reads preserve its row; a failed read offers Retry while the binding remains. Still-bound runs recover metadata on remount and reconnect. Retained metadata and late results cannot recreate an unbound row or replace a next-send selection. Requests remain fenced by client, Scope, Session, capability selection and reconnect generation; newer matching Blueprint events supersede older reads. Status presentation does not poll or load message bodies.

Blueprint first-prompt delivery awaits execution. An abort while the Session pause latch is present belongs to the explicit pause/abandon operation, so the start callback cannot independently mark it failed. Real delivery failures, including transport aborts without a user interruption, still record failure. Cancellation tests exercise the real Session abort path and storage to protect that ordering.

## Alternatives considered

**Restore separate toolbar icons.** Icons alone do not explain review or failure and lose their labels in compact layouts. They also duplicate inspection and workflow controls.

**Retain historical results in the Composer.** A read-only failed, unavailable or resolving row without a Session binding misrepresents attachment. Conversation and process records already retain diagnostics.

**Show draft selections as Loop rows.** A next-send choice is not an established Session binding. Its selected state remains in the draft rather than creating a bound-work indicator.

**Hide the row on canonical terminal metadata.** The Loop record can update before the Session binding. Using it as another visibility authority breaks the one-to-one projection of Session binding; terminal metadata changes the bound row's labels and controls instead.

**Infer success when the Session becomes idle.** Review, cancellation and failure all have idle intervals. Only the owning Loop's canonical result establishes acceptance.

**Refetch the conversation on each stage change.** Active Session metadata and matching Blueprint snapshots and events already contain the required state. Reloading conversation content introduces redundant traffic and reading-position changes.

## Consequences

Clearing the Session binding removes its row, controls and owned details dialog without replacing the editor, draft or next-send selection. A bound row may display terminal metadata until the Session update arrives; an unbound Session displays no Loop row even with a draft selection. The Composer gives up unbound terminal-result inspection and detached lookup retries; conversation and process records retain the diagnostics, and Blueprint Notes retain the latest result and execution-session link. Navigation, reload and reconnect cannot restore an unbound row from historical metadata.

The [failure-state incident analysis](../../../postmortem/0082-loop-failure-state-divergence.md) records superseded evidence and the strict-rule regression requirements. Acceptance must establish that mounted row presence follows Session binding in both event orders, without historical queries or orphaned details dialogs.
