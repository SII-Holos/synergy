# Decision Record: Session Browser Workspace tabs

Status: implemented

## Problem

Sessions in one project have independent Workspace layouts, but reconciling the shared Browser catalog adds every project page to each layout. Opening a page in one Session therefore adds an unsolicited tab to another. Opening an empty Workspace also selects the most recently used project page, even when it belongs to another Session's activity.

## Decision

Ordinary pages remain in the project catalog, and login profiles keep their installation-wide identity. Each Session's saved Workspace tabs determine which of those pages it displays. Reconciliation updates existing titles and addresses and removes closed pages. It adds shared popups only when their opener ancestry reaches an already-open tab in that Session. Explicit resource opens retain their existing Session-bound completion checks and local tabs remain visible when their response precedes the catalog event.

Opening an empty Workspace creates a blank page with the existing default profile. Existing tabs restore their saved page identity, and explicit page targets can still open shared resources. Historical Session-owned catalogs retain their own page discovery. Agent access, native page lifetime, profile partitions and website data keep their existing ownership.

This refines the presentation portion of [Resource Workspace and project Browser](../architecture/2026-10-01-resource-workspace-and-project-browser.md). Existing saved tab membership is preserved because stored tabs do not distinguish deliberate opens from earlier catalog additions. No persisted format or browser storage migration is required.

## Alternatives considered

**Move every ordinary page to Session ownership.** Rejected for this change because tab independence can be enforced in the Workspace while retaining browsing before task creation and explicit use of shared pages.

**Keep adding the whole catalog but avoid selecting new tabs.** Rejected because unsolicited tabs still change another Session's Workspace, even when its active tab stays selected.

**Suppress every catalog addition.** Rejected because native website popups must remain available beside their opener, including when their event arrives before the initiating open response.

## Consequences

Sessions keep independent page lists and selection while sharing the default login store. The frontend retains opener ancestry when reconciling shared pages, and empty-Workspace creation does not reuse an unrelated project page. A shared page explicitly opened in multiple Sessions still represents one native page; its navigation and closure remain shared.

Behavioral coverage includes empty and populated Session layouts, A/B switches, inactive title updates, page closure, nested popups, pending opens and explicit shared-page access. The current behavior is documented in [Browser workspace](../../../product/browser.md), [Browser runtime](../../../architecture/browser-runtime.md) and [Frontend data sync](../../../architecture/frontend-data-sync.md).
