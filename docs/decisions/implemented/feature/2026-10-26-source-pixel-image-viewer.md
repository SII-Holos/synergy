# Decision Record: Source-pixel image viewing

Status: implemented

## Problem

Image previews previously treated a fitted image as 100%, retained unreachable pan offsets, and did not refit a rotated image. Independent modal and workbench transforms made these semantics inconsistent.

## Decision

`packages/ui/src/components/image-viewer-model.ts` owns source-pixel geometry. Actual size means one source pixel per CSS pixel. Fit contains the rotated bounds without enlarging small images. Zoom anchors the source point beneath the pointer; boundary correction takes precedence when an edge would otherwise become unreachable. Manual zoom survives viewport resizing, while fit is recomputed.

Rotation is in quarter turns. Pan is clamped against the displayed rotated bounds and centers axes that do not overflow. Image identity includes both entry ID and source, so gallery entries sharing a URL remain distinct. Model tests cover these invariants, modifier-aware keyboard routing, wheel input, and viewports smaller than normal padding.

`ImageViewer` is the single viewport for the modal, Files and Attachment Workspace. The shells retain their resource routing and SVG safety boundaries. Typed host actions keep App services out of shared UI; `apps/web/src/utils/image-actions.ts` owns byte reads, PNG clipboard conversion and original-byte saving. It reuses the existing native file-action bridge without creating a Browser page or another IPC path. The toolbar and themed Kobalte menus consume the same commands. Fullscreen portals remain inside the fullscreen root.

Operations capture their image and cancellation signal. A changed or inactive view aborts pending reads and ignores late results. Native save completion and cancellation are reported separately; a Web anchor dispatch reports only that a download started. A failed read is not replaced by opening an unverified URL. Clipboard admission starts within the user gesture, with PNG decoding supplied as a promise.

Source navigation shares that operation lifetime, including cancellation before closing its modal. Attachment SVG preview uses image decoding, while its text reader runs only in Source mode; a failed text request must not remove image retry or save controls. Files retains its existing sanitized SVG display and saves the original bytes.

Keyboard context-menu keys use the same Kobalte menu and return focus to their invoking image control. Gallery navigation reveals the selected thumbnail without moving focus out of the image stage.

Desktop grants HTML fullscreen only to the current application window's main frame, with the requesting URL matched against that window and the trusted app origin. Subframes, other windows, recovery documents and other permissions retain their existing restrictions. A minimal Electron 44.9.0 probe reproduced a pending fullscreen promise under the previous blanket denial; the fix stays at the session permission owner rather than introducing a second fullscreen implementation. The request identity fields follow Electron's [PermissionRequest contract](https://www.electronjs.org/docs/latest/api/structures/permission-request).

## Alternatives considered

**Keep fit-relative percentages.** Rejected because 100% would still conceal source pixels and mean different things in differently sized surfaces.

**Maintain separate modal and workbench transform models.** Rejected because boundary, rotation, and input fixes would continue to diverge. Shells supply resources and host actions rather than implementing geometry.

**Expand resource opening into a byte and clipboard service or add image IPC.** Rejected because opening and byte operations have different ownership. The existing SDK, platform fetch and native file-action contract already supply the required boundaries.

## Consequences

The geometry is independently testable without a browser, but browser tests remain necessary for pointer capture, image loading, focus, menus, and actual rendered dimensions. Fit is the minimum useful scale; zoom can reach eight times source size. This limits meaningless empty-canvas zooming without preventing inspection of large images.
