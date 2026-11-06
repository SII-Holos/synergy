# Decision Record: Prepare Browser Workspace presentation before expansion

Status: implemented

## Problem

Opening an empty Desktop Workspace starts its width transition before asynchronous page creation and lazy Browser controls finish. A page tab appearing halfway through expansion interrupts the transition. The new-tab import action can also return without feedback when no active page or native data capability is available.

## Decision

The workbench projects a transient Browser tab and a lightweight new-tab frame before expansion starts. Preparation remains renderer-local; canonical page state upgrades the same tab only after an active page is observed. Catalog updates retain their epoch and sequence ordering, and additions arriving during preparation cannot steal selection or duplicate the pending tab. The native Browser protocol, public Plugin API and persisted layout format remain unchanged.

The import entry immediately mounts a dialog with preparation feedback and a bounded discovery deadline. It shares the initiating opening operation, then captures the server, canonical owner, page ID and native data action. The dialog survives replacement of its source frame; its context validity remains reactive when the Workspace owner is disposed or the Session changes, including before a page resolves. Errors stay visible with Retry, and a changed or closed target requires reopening. Only explicit Import reads credential data; preparation discovers metadata.

Collapse and reopen reuse the pending operation. Explicitly closing a pending tab arranges cleanup of its newly created late page; changing Session abandons presentation without closing shared pages. An unknown creation outcome retains its request identity and original restore choice. A known missing page never becomes a replacement page. The current invariants live in [Browser runtime](../../../architecture/browser-runtime.md), and interaction requirements live in [Browser workspace](../../../product/browser.md).

## Alternatives considered

**Wait for native readiness before expanding.** This postpones the user's Workspace feedback by the full creation and loading delay. Immediate presentation keeps the opening action responsive while exposing preparation.

**Disable import until the page becomes active.** This hides the reason for the unavailable action and provides no recovery path. An immediate dialog can explain preparation or failure while retaining its original target.

**Insert a permanent blank tab or optimistically copy the open response into the catalog.** A permanent placeholder can outlive failed creation, while an unguarded catalog write can override newer events. Transient presentation and canonical refresh keep persistence and catalog ownership intact.

## Consequences

The renderer owns additional temporary opening state and must coordinate cancellation, selection, retry and dialog lifetime. A lightweight frame is visible while the full panel loads, and navigation stays disabled during that interval. Rendered regressions hold asynchronous creation and cover first-frame presentation, event ordering, import discovery, hidden Workspace completion, closure and Session changes. Existing native data actions retain their generation checks and cancellation semantics. No installed Desktop process is required by the deterministic renderer fixtures; native acceptance remains separate evidence.
