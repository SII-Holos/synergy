# Decision Record: Bounded conversation process rendering

Status: implemented

## Problem

A turn-wide process renderer and independently virtualized Parts have different lifetimes. Rendering the process entrance in every body row duplicates controls; storing disclosure inside those rows cannot collapse the whole process. Rendering the entire turn instead would reload unbounded historical bodies. Summary-only headers can also mistake unloaded content for a provider that has not replied.

## Decision

The App row projection gives each root one process entrance and one completion footer. It passes turn-wide execution and content-presence metadata plus shared disclosure to the UI renderer. Text stays independently virtualized. Adjacent tool and reasoning Parts form batches bounded by six Parts and 128 KiB of declared body data. Existing batch starts survive history prepends. Closing a process removes its body rows while keeping the final answer and completion actions.

Focused controls, selected text and a reader above the latest position hold automatic completion collapse. Explicit disclosure remains authoritative. Search expands the owning process before locating a Part. Body leases, message slots and the existing virtual scrolling element retain their owners.

The authoritative implementation is [conversation rows](../../../../apps/web/src/components/session/conversation-rows.ts), [virtual rows](../../../../apps/web/src/components/session/virtual-conversation-rows.tsx) and [SessionTurn](../../../../packages/ui/src/components/session-turn.tsx). Bounds and lifecycle are documented in [frontend data sync](../../../architecture/frontend-data-sync.md).

## Alternatives considered

**Render complete turns as one virtual item.** A single large turn defeats body paging and can consume the input thread and memory budget.

**Keep independent process controls in every Part row.** This duplicates status and prevents one disclosure action from controlling the round.

**Rebatch from the first loaded Part on every update.** Prepending history changes existing row identities and destroys focus or reading anchors even when their content is unchanged.

## Consequences

Long turns retain one coherent process while reading bounded bodies. Very long contiguous activity can span several batches; there is no unbounded turn-sized tool group. Pure row regressions cover complete Part membership and stable prepends. UI regressions exercise shared disclosure, final-answer retention and provider status with actual process components.
