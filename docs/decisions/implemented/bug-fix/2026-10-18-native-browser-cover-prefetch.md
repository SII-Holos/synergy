# Decision Record: Precapture the native Browser still

Status: implemented

## Problem

Electron composites a page's `WebContentsView` above the renderer document, so any overlaying surface has to hide the native view to be visible. `NativeBrowserSurface` hides it whenever the address bar options menu, address suggestions, find bar, page dialog, file chooser, annotation controls, application dialog or a Workspace menu opens. Desktop produced its bounded still image only on the visible-to-hidden transition, so the image arrived one IPC round trip plus a JPEG decode after the view had already hidden. Frame analysis of a 30 fps recording measured one to two fully blank frames on every options-menu click, a 33–66 ms flash that repeats for each open and close.

## Decision

`NativeBrowserSurface` precaptures one bounded JPEG still while the page is visible and settled, decodes it, and keeps it mounted beneath the native view for as long as it matches the current page and URL. The hide then uncovers an image the document has already painted instead of an empty surface, and no overlay waits for a capture. The still is requested through a dedicated `cover` page action that shares the existing page-action transport, so Web, Desktop and the protocol keep one contract.

A capture is gated on an active, non-loading, non-blank page with finite bounds, a ready host and a visible surface. It is sequence-guarded against concurrent captures and page changes, races a 400 ms deadline so a stalled page cannot delay a later hide, and is rejected above `BROWSER_MAX_COVER_BYTES` (1.4 MB). Desktop re-verifies the page URL before and after capture and refuses an empty or navigated image. The hide-time still from Desktop still replaces the cached one once it arrives, so the visible image converges to the exact pre-hide content.

Capture and image decoding share one deadline. A newer native cover, visibility change or page change invalidates the pending result; failed decoding cannot replace accepted content. Regression coverage holds an older response across a newer cover and across deactivation.

## Alternatives considered

**Capture synchronously, then hide.** Rejected because the overlay would wait for an IPC round trip, a compositor capture and a decode before appearing. A 400 ms bound would still make routine menu opens feel unresponsive, and the delay would apply to every blocker including keyboard-driven ones.

**Keep hiding first and accept the blank frames.** Rejected because that is the reported defect: the native view is a separate compositor layer, so the document cannot fill the gap in time no matter how the overlay is styled.

**Raise the overlay's CSS stacking level above the native view.** Rejected because the native page is not composited inside the renderer's stacking order, which is the same constraint recorded in [Workspace menus over native Browser](2026-10-12-workspace-native-browser-menus.md).

**Detach the view on every overlay and reattach after.** Rejected because detachment drops the visible surface and forces a fresh compositor attachment, which is slower than the hide it replaces and can stall capture on a page that has not yet presented.

## Consequences

Each visible Browser panel retains one bounded still in renderer memory. The revealed image can lag the live page until Desktop's hide-time still arrives, so a page scrolled immediately before opening a menu may briefly show its earlier position; the refresh is bounded and self-correcting rather than permanent. The still is never used as a transport, never survives a page or URL change, and is not persisted or synchronized. New blocking overlays inherit the behaviour automatically because they already participate in the visibility calculation.
