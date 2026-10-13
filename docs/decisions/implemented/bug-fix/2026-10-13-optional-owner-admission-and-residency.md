# Decision Record: Optional owner admission and native panel residency

Status: implemented

## Problem

Selecting optional workflow components made application startup enumerate the complete Session subtree, including message parts and rollout history. Large retained stores could exceed SQLite liveness limits before serving health requests. Independently, resetting capabilities during a WebSocket reconnect removed native workbench tabs from the visible projection and destroyed their mounted editors, despite their saved resource identities remaining valid. See the [incident analysis](../../../postmortem/0073-optional-owner-startup-and-panel-reset.md).

## Decision

Blueprint, Light Loop and Lattice retain their existing owner migration IDs and pure conversions. The central runner applies Session metadata changes on access with per-Session receipts; canonical message reads apply record transforms and foreground display preparation refreshes the requested window. A released global receipt does not suppress owner access. Light Loop terminal extraction and removal of the active workflow commit in one storage transaction. Explicit migration maintenance enumerates indexed Session metadata rather than every descendant record.

The workbench retains already mounted native panels during an unknown capability snapshot if their saved resource identity still exists. Those presentations are hidden, inert and paused inside the existing eight-instance budget. Confirmed absence and saved-tab closure retire them. Third-party presentations retain the stricter capability and generation lifetime rules described by [frontend synchronization](../../../architecture/frontend-data-sync.md).

## Alternatives considered

**Increase startup deadlines.** This retains work proportional to all historical descendants and makes ordinary startup depend on storage size. It does not address the admission contract.

**Keep the last capabilities authoritative while reconnecting.** This permits stale optional requests and plugin work. Retaining only inactive native presentation state preserves interaction continuity without granting capabilities.

**Destroy every presentation and restore its serialized draft.** This loses selection, scroll position and editor-local state and reintroduces loading on transient transport failures.

## Consequences

Cold metadata conversion moves to the first owner read and message compatibility remains bounded to the requested history window. Existing storage formats and historical ledgers are preserved. Tests cover pending and completed global receipts, populated histories, display versions, terminal rollback and repeated access. Native panels consume a residency slot during revalidation, while confirmed removal remains authoritative. Rendered tests assert retained DOM and selection, closed-tab cleanup and unchanged third-party disposal.
