# Decision Record: Source-pixel image viewing

Status: implemented

## Problem

Image previews previously treated a fitted image as 100%, retained unreachable pan offsets, and did not refit a rotated image. Independent modal and workbench transforms made these semantics inconsistent.

## Decision

`packages/ui/src/components/image-viewer-model.ts` owns source-pixel geometry. Actual size means one source pixel per CSS pixel. Fit contains the rotated bounds without enlarging small images. Zoom anchors the source point beneath the pointer; boundary correction takes precedence when an edge would otherwise become unreachable. Manual zoom survives viewport resizing, while fit is recomputed.

Rotation is in quarter turns. Pan is clamped against the displayed rotated bounds and centers axes that do not overflow. Image identity includes both entry ID and source, so gallery entries sharing a URL remain distinct. Model tests cover these invariants, modifier-aware keyboard routing, wheel input, and viewports smaller than normal padding.

`ImageViewer` is the single viewport for the modal, Files and Attachment Workspace. The shells retain their resource routing and SVG safety boundaries. Typed host actions keep App services out of shared UI; `apps/web/src/utils/image-actions.ts` owns byte reads, PNG clipboard conversion and original-byte saving. It reuses the existing native file-action bridge without creating a Browser page or another IPC path. The toolbar and themed Kobalte menus consume the same commands. Fullscreen portals remain inside the fullscreen root.

Operations capture their image and cancellation signal. A changed or inactive view aborts pending reads and ignores late results. Native save completion and cancellation are reported separately; a Web anchor dispatch reports only that a download started. A failed read is not replaced by opening an unverified URL. Web clipboard writes use the shared `clipboard-core` boundary: admission starts within the user gesture, with PNG decoding supplied as a promise. Unavailable image writing never falls back to copying text, and admission failure still observes a later conversion rejection.

Source navigation shares that operation lifetime, including cancellation before closing its modal. Attachment SVG preview uses image decoding, while its text reader runs only in Source mode; a failed text request must not remove image retry or save controls. Files retains its existing sanitized SVG display and saves the original bytes.

Keyboard context-menu keys use the same Kobalte menu and return focus to their invoking image control. Stateful commands use Kobalte checked items driven by the existing command state, keeping visible marks, keyboard activation and accessibility state aligned. Controls retain the shared focus treatment, while the canvas keeps its resting surface. Gallery navigation reveals the selected thumbnail without moving focus out of the image stage.

Desktop grants HTML fullscreen only to the current application window's main frame, with the requesting URL matched against that window and the trusted app origin. Subframes, other windows, recovery documents and other permissions retain their existing restrictions. A minimal Electron 44.9.0 probe reproduced a pending fullscreen promise under the previous blanket denial; the fix stays at the session permission owner rather than introducing a second fullscreen implementation. The request identity fields follow Electron's [PermissionRequest contract](https://www.electronjs.org/docs/latest/api/structures/permission-request).

## Alternatives considered

**Keep fit-relative percentages.** Rejected because 100% would still conceal source pixels and mean different things in differently sized surfaces.

**Maintain separate modal and workbench transform models.** Rejected because boundary, rotation, and input fixes would continue to diverge. Shells supply resources and host actions rather than implementing geometry.

**Expand resource opening into a byte and clipboard service or add image IPC.** Rejected because opening and byte operations have different ownership. The existing SDK, platform fetch and native file-action contract already supply the required boundaries.

## Consequences

The geometry is independently testable without a browser, but browser tests remain necessary for pointer capture, image loading, focus, menus, and actual rendered dimensions. Fit is the minimum useful scale; zoom can reach eight times source size. This limits meaningless empty-canvas zooming without preventing inspection of large images.

## Verification

The shared viewport and controls run through the production Vite pipeline in `apps/web/test/components/attachment-workbench/image-viewer.dom.test.ts`; the adjacent content and message suites exercise host integration. Bun cannot attribute Chromium execution to these source modules. Exact-file coverage entries identify those suites and the thin platform hook; the action interface is types-only. Geometry, byte operations, clipboard admission and Desktop permission decisions remain directly measured without lowering package thresholds.

The existing file-workbench HTML preview development suite also guards the SDK import boundary. Image actions import the browser client entry, not the root SDK export that loads Node server helpers; production tree-shaking alone did not expose that regression.

Resource-opening and workbench-view fixtures resolve both platform import forms to their existing host adapters and assert successful rendering at bootstrap. A missing context now fails at its cause rather than timing out every downstream action against a blank page.

Package-wide Web and UI checks are not green. A separate checkout of the starting revision reproduces the workbench-view focus-protection failure and some other suite failures, but not every observed failure. The unresolved results remain outside the focused image-viewer evidence; no test assertions or package thresholds were relaxed.

Isolated Desktop acceptance covers message-gallery navigation, Files and Attachment viewing, source-sized native clipboard images, both themes, a 640 × 420 window, real 200% page zoom, extreme image aspect ratios and HTML fullscreen focus. HTML fullscreen fills the application renderer; the minimal Electron probe does not establish a native macOS window-mode transition. Native save-sheet cancellation and on-disk completion remain unverified because the available native observation channel cannot inspect that sheet. Touch interactions have browser regression coverage, not physical touch-device acceptance.
