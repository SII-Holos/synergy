# Decision Record: Recover native logout before renderer reload

Status: implemented

## Problem

A renderer could show pending logout before Main received its request. Reloading during controlled-cache deletion then accepted Main's still-ready descriptor and reopened the organization. A delayed connection-ID-only request could also target a later login for the same account. Renderer-only state and optimistic headings could not establish which logout Main had durably accepted.

## Decision

The connection owner stores one strict, credential-free version-1 intent per Space in a separate IndexedDB database. A point transaction preserves the first request's account, issuer, deployment, client, connection ID and observed native revision. Another window receives the existing intent rather than replacing it. Exact transaction removal cannot delete a newer request, and controlled-cache deletion excludes the intent database.

Desktop bridge version 2 exposes the account owner's existing opaque revision and requires prepare/commit logout phases. Prepare compares the original revision and durably records the request nonce as pending before any revocation. The renderer then removes controlled caches and commits that same nonce. Main retains it in the final signed-out descriptor, making retries and lost final acknowledgements idempotent. Existing pending native records resume with their own durable revision. The native credential record format does not change.

Reload consults the intent before admitting a ready descriptor. A confirmed matching final receipt removes only its intent; concurrent recovery also accepts an already removed intent without deleting its replacement. A refresh or later login receives a different revision and rejects the older action. Explicit connection restoration can adopt the current descriptor after clearing the obsolete intent; it never sends the old action against new credentials. Missing bridge versions and selectors fail closed instead of receiving compatibility defaults.

The connection form keeps its error beside its fields without introducing another grid child. Project views clear loaded metadata, edit drafts and child navigation on confirmed owner loss, while ordinary service failure preserves the unsaved draft. Styled browser fixtures include their actual public assets in both build and cache identity so screenshots inspect the product mark rather than a broken-image placeholder.

## Alternatives considered

**Only persist Main's pending state.** This leaves the renderer-to-Main interval unrecorded. A real App fixture reproduced reload before prepare reached Main.

**Use a localStorage marker.** Separate read/write/delete operations allow two windows to replace or delete another request. IndexedDB provides point transactions without a second credential authority.

**Rebase the old action onto the latest login.** It would revoke authority the user granted after initiating the original action. A connection change requires explicit recovery instead.

## Consequences

Native logout remains one user action with two internal phases. Unavailable persistent metadata blocks the action with recovery guidance; neither credentials nor request bodies enter this store. Old native bridges require an application restart or update. Account, IPC, connection and real IndexedDB fixtures cover durable preparation, restart, refresh conflicts, legacy pending records, later login, reload before Main acceptance, concurrent final recovery and exact replacement retention. App fixtures cover narrow/wide connection errors, project authority loss and transport recovery. Native OS encryption and Electron rendering retain their existing independent acceptance requirements.

The [postmortem](../../../postmortem/0117-renderer-reload-reopened-pending-logout.md) records the reproduced race and its checks.
