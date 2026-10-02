# Decision Record: Resource Workspace state and project Browser

Status: implemented

## Problem

Workspace presentation, document edits and browser page lifetime require different ownership. Document navigation that continually adds tabs makes browsing cumbersome, while replacing a singleton editor can lose queued edits and history. Task-bound webpages require empty tasks for ordinary browsing and make same-project collaboration depend on a task’s file binding.

## Decision

The shared side and bottom shell stores resource references and presentation preferences. Notes controllers own baselines, drafts, save queues, conflicts and retained editor history; Files retain their Workspace and binding generation. Document clicks replace the current same-type tab through its close policy, while explicit new-tab actions preserve multiple documents. Layout version 2 migrates order, active resource, open state and preferred dimensions through the existing frontend persistence entry. A new Session retains draft resources with both surfaces closed.

Workspace uses one resource strip and resource toolbar, independent navigation preferences, responsive overlays and modal navigation drawers. Temporary width constraints do not replace saved dimensions. Hidden content is inert; nested overlays handle Escape first. Output visibility has one persisted allowance per task and preserves focus. Manual resource selection or collapse, an active editor/dialog, historical output and background tasks cannot override that choice.

Ordinary webpages use the existing Scope owner without a Workspace binding. They exist before a Session and survive task completion, cancellation and Workspace transitions. Historical and local-file pages retain their Session owner. The frontend reuses one Scope catalog and WebSocket across Sessions and uses the server’s canonical ownerKey for routing and native tickets. Human selected resource and explicit Agent page targets remain independent.

Agent operations acquire the initiating Session’s Environment and Workspace binding lease before the page queue. File actions retain that task’s generation, authorization and upload/export admission. Replay identities include the initiating Session, and Protocol v5 activity carries Session and operation identity so an old operation cannot clear a newer one. Core, Runtime, Desktop, Web and generated SDK share the version; the generic plugin UI API remains version 6. Existing owners and login partitions are not merged or migrated to Scope ownership.

Explicit Desktop opening restores the most recently viewed project page or creates a real blank page; metadata reads and layout restoration allocate none. Screenshot and download additions capture an existing Session or a new-task draft generation before asynchronous work, retain ordinary typing and reject a changed/reset destination without creating an empty Session.

## Alternatives considered

**Retain singleton Notes and component-owned draft state.** Rejected because tab replacement and Session changes destroy the view while queued saves, conflicts and editor history still belong to the original document.

**Create a document tab on every list click.** Rejected because browsing a directory grows the tab strip and hides the intentional distinction between switching and preserving documents.

**Require a task to own ordinary webpages.** Rejected because ordinary browsing has no task or filesystem requirement and same-project tasks should share pages without transferring file authority.

**Move historical pages and combine browser identities.** Rejected because historical file ownership and login partitions must retain their original authority and recovery behavior.

## Consequences

Resource lifetime is stable across presentation changes, and ordinary browsing works independently of model execution. The change costs explicit document controllers, canonical resource identity, task-context leases and catalog reconciliation on Session changes. Dirty, mounted and undoable Notes controllers survive clean-cache eviction; local backup failure is visible and protects unload. Retained editor views disable stale transaction dispatch before unmounting so asynchronous decoration callbacks cannot mutate a replacement view.

Behavioral tests exercise replacement and deduplication, save revision races, draft/baseline recovery, close protection, responsive dimensions, finite reveal policy, shared page authority and native lifecycle. Browser tests retain isolated homes, ports and Electron userData. See [Browser runtime](../../../architecture/browser-runtime.md), [Frontend data sync](../../../architecture/frontend-data-sync.md) and [Web product contract](../../../../apps/web/PRODUCT.md) for current behavior; native page and identity decisions remain in [Desktop browser pages and identities](2026-09-29-desktop-browser-pages-and-identities.md).
