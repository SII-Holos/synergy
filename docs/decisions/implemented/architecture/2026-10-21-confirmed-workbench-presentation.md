# Decision Record: Confirm Workbench presentation through the target frontend

Status: implemented

## Problem

Resources share a frontend workbench but a Browser-specific tool treats returned metadata as a presentation command. Removing its consumer leaves the tool reporting that a panel was shown without changing the UI. Adding one view tool per resource would duplicate routing, attention rules and lifecycle behavior while preserving the same missing confirmation.

## Decision

Workbench owns one `workbench_view` tool for presenting existing resources, inspecting presentation and hiding an identified view. It reuses the existing resource opener, panel registry and resource owners. Server exposes connection-scoped contributions on the existing global event WebSocket; it does not import Workbench business logic or create another presentation transport. Portable schemas are shared without moving resource ownership into utilities.

Requests select one matching active frontend and complete from its execution receipt, not from a successful send or a completed transcript Part. Ambiguous destinations remain explicit. Missing receipts after dispatch remain unknown. Commands are transient and never replay from history or reconnect; their final receipts use existing Session history. Browser-specific view execution is removed rather than retained as an alias.

Explicit Agent presentation may change the current workbench resource selection, but cannot activate the OS app, take keyboard focus, overwrite drafts or defeat a newer user selection. File, Note, Asset and Browser identity and authorization remain with their existing owners. Browser page creation and navigation remain separate operations.

Mixed-action tools declare additional input-dependent resource needs on their initialized definition. The existing resolver acquires them before permission classification instead of adding a Workbench special case or a second resource/permission pipeline. File presentation captures those selected resources for directory and object storage without requiring a local Session projection or acquiring another binding. It keeps exact resolved read checks; directory-independent actions retain their original availability. Browser panel initialization carries a no-autofocus intent for Agent requests, including existing blank pages.

## Alternatives considered

**Restore the Browser metadata consumer and add equivalent Note and File consumers.** Rejected because consumers would remain tied to transcript loading and each domain would duplicate target routing, stale-result handling and attention policy. It also leaves no reliable execution acknowledgement.

**Expose arbitrary UI commands, panel state or DOM selectors.** Rejected because it gives a resource-display tool unrelated navigation and execution authority and binds the Agent contract to component implementation details.

**Use Computer automation or another browser/controller transport.** Rejected because presentation already has a typed in-app owner and should not need physical input, operating-system focus or a second runtime.

**Broadcast to all clients or guess a primary window.** Rejected because multiple clients can display the same Session and no existing unique owner makes that choice authoritative. A concrete eligible client is selected or ambiguity is returned.

**Persist and replay a UI command queue.** Rejected because opening an old view after the user reconnects or switches tasks is an unwanted effect, not durable business work. Unknown outcomes require observation, not automatic repetition.

## Consequences

Presentation uses one execution path and accurate result semantics while retaining existing editor and Browser lifetimes. The cost is a typed request/receipt lifecycle and an explicit ambiguous-client outcome. Client acknowledgement establishes frontend application state, not content loading, native pixels or user attention. The [architecture reference](../../../architecture/workbench-presentation.md) defines current invariants, and the [incident report](../../../postmortem/0087-browser-view-completed-without-presentation.md) records the observed failure.
