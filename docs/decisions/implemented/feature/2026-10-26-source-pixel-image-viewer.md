# Decision Record: Source-pixel image viewing

Status: implemented

## Problem

Image previews previously treated a fitted image as 100%, retained unreachable pan offsets, and did not refit a rotated image. Independent modal and workbench transforms made these semantics inconsistent.

Fullscreen entry is asynchronous. Before it resolves, `document.fullscreenElement` can still be empty; treating that as permission to dismiss a preview lets Escape detach its requesting element while the native window is entering fullscreen. An inactive retained viewer can also miss the later entry if its cleanup observes activity alone.

## Decision

`packages/ui/src/components/image-viewer-model.ts` owns source-pixel geometry. Actual size means one source pixel per CSS pixel. Fit contains the rotated bounds without enlarging small images. Zoom anchors the source point beneath the pointer; boundary correction takes precedence when an edge would otherwise become unreachable. Manual zoom survives viewport resizing, while fit is recomputed.

Rotation is in quarter turns. Pan is clamped against the displayed rotated bounds and centers axes that do not overflow. Image identity includes both entry ID and source, so gallery entries sharing a URL remain distinct. Model tests cover these invariants, modifier-aware keyboard routing, wheel input, and viewports smaller than normal padding.

`ImageViewer` is the single viewport for the modal, Files and Attachment Workspace. The shells retain their resource routing and SVG safety boundaries. Typed host actions keep App services out of shared UI; `apps/web/src/utils/image-actions.ts` owns byte reads, PNG clipboard conversion and original-byte saving. It reuses the existing native file-action bridge without creating a Browser page or another IPC path. The toolbar and themed Kobalte menus consume the same commands. Fullscreen portals remain inside the fullscreen root.

Operations capture their image and cancellation signal. A changed or inactive view aborts pending reads and ignores late results. Native save completion and cancellation are reported separately; a Web anchor dispatch reports only that a download started. A failed read is not replaced by opening an unverified URL. Web clipboard writes use the shared `clipboard-core` boundary: admission starts within the user gesture, with PNG decoding supplied as a promise. Unavailable image writing never falls back to copying text, and admission failure still observes a later conversion rejection.

Source navigation shares that operation lifetime, including cancellation before closing its modal. Attachment SVG preview uses image decoding, while its text reader runs only in Source mode; a failed text request must not remove image retry or save controls. Files retains its existing sanitized SVG display and saves the original bytes.

Keyboard context-menu keys use the same Kobalte menu and return focus to their invoking image control. Stateful commands use Kobalte checked items driven by the existing command state, keeping visible marks, keyboard activation and accessibility state aligned. Controls retain the shared focus treatment, while the canvas keeps its resting surface. Gallery navigation reveals the selected thumbnail without moving focus out of the image stage.

Cached image elements enter the existing load-completion path on mount when `complete` and a positive natural width establish readiness. Waiting only for another queued `load` event briefly disabled the toolbar and hid an already cached image during gallery navigation. Mount also measures the viewport through the same resize path used by `ResizeObserver`, so a cached first image is fitted before readiness rather than briefly using an unmeasured viewport. This uses the actual mounted element, not the saved transform as a proxy for loading, and retains the key/attempt fence, pending/error states and retry behavior without another image cache or delayed spinner policy.

The canvas is a context-menu interaction region, not a toggle button. Only its context-menu content clears the trigger exclusion forwarded to Kobalte's existing dismissable layer, allowing blank-canvas and image clicks to dismiss through the same outside-interaction and focus policy. This relies on the pinned [Kobalte 0.13.14](https://www.npmjs.com/package/@kobalte/core/v/0.13.14) `MenuContentBase` forwarding `excludedElements`; it is a layer option rather than a declared `ContextMenu.Content` prop. Browser regressions guard that narrow dependency. Dropdown triggers keep their default exclusion, and pointer capture, keyboard invocation and fullscreen portals are unchanged. There is no global click listener or parallel menu state.

Gallery arrows use existing neutral surface tokens for distinct hover and pressed states, with the shared fast transition and a centered press scale. Hover applies only to hover-capable fine pointers, disabled arrows remain static, and reduced motion retains color feedback without scaling or transitions. The resting fill sets only the background color so it does not erase the shared keyboard-focus treatment; no component-local focus perimeter or palette is introduced.

The image-preview shell follows Settings' visual treatment: 12px corners, the same canonical canvas and border colors, dialog elevation, and a neutral inset close control with 8px corners and 12px edge clearance. The preview retains its image-oriented dimensions and header rather than importing App-owned Settings styles into shared UI or replacing the viewer's focus/fullscreen lifecycle. Fine-pointer close controls match Settings' 30px size; coarse pointers retain a 44px target. Background-color changes preserve the shared keyboard-focus surface.

Desktop grants HTML fullscreen only to the current application window's main frame, with the requesting URL matched against that window and the trusted app origin. Subframes, other windows, recovery documents and other permissions retain their existing restrictions. A minimal Electron 44.9.0 probe reproduced a pending fullscreen promise under the previous blanket denial; the fix stays at the session permission owner rather than introducing a second fullscreen implementation. The request identity fields follow Electron's [PermissionRequest contract](https://www.electronjs.org/docs/latest/api/structures/permission-request).

The viewer owns one pending fullscreen entry and its cancellation intent. Escape during that request is consumed before modal dismissal; repeated Escape or activation cancels the same request without starting another. Once entry resolves, cancellation exits through `document.exitFullscreen()` only if that viewer still owns the fullscreen element. Rejection clears the request so the viewer remains usable. Inactive views observe fullscreen changes as well as activity and release late entry. This preserves a window that was already in native fullscreen: Electron's [HTML fullscreen implementation](https://github.com/electron/electron/blob/v44.9.0/shell/browser/api/electron_api_web_contents.cc) retains the preexisting native mode when HTML fullscreen exits. A renderer timeout or unconditional native-window exit would discard that ownership distinction.

## Alternatives considered

**Keep fit-relative percentages.** Rejected because 100% would still conceal source pixels and mean different things in differently sized surfaces.

**Maintain separate modal and workbench transform models.** Rejected because boundary, rotation, and input fixes would continue to diverge. Shells supply resources and host actions rather than implementing geometry.

**Expand resource opening into a byte and clipboard service or add image IPC.** Rejected because opening and byte operations have different ownership. The existing SDK, platform fetch and native file-action contract already supply the required boundaries.

## Consequences

The geometry is independently testable without a browser, but browser tests remain necessary for pointer capture, image loading, focus, menus, and actual rendered dimensions. Fit is the minimum useful scale; zoom can reach eight times source size. This limits meaningless empty-canvas zooming without preventing inspection of large images.

## Verification

The shared viewport and controls run through the production Vite pipeline in `apps/web/test/components/attachment-workbench/image-viewer.dom.test.ts`; the adjacent content and message suites exercise host integration. Bun cannot attribute Chromium execution to these source modules. Exact-file coverage entries identify those suites and the thin platform hook; the action interface is types-only. Geometry, byte operations, clipboard admission and Desktop permission decisions remain directly measured without lowering package thresholds.

The existing viewer browser fixture also covers both gallery arrows in light and dark themes: resting, hover, press, first/last disabled states, stable centers and actual image changes. Reduced-motion keyboard activation retains a visible focus surface and press feedback without motion; narrow touch interaction retains the existing target size without sticky hover. These checks complement rather than duplicate the existing geometry and gallery-navigation tests.

That fixture mounts the real Settings dialog frame and stylesheet as a visual reference. Light/dark comparisons guard the preview's computed surface, close-button size, placement, icon and resting/hover/pressed/focused colors rather than asserting duplicated CSS source strings. The preview's keyboard-focus overlay, close focus return and coarse-pointer close target remain separately asserted; Settings behavior is unchanged.

Navigation regressions inspect the initial fitted bounds before the first resize notification, cached-image readiness and toolbar availability before the next load event, while a held image response verifies pending controls and late-load isolation. Context-menu dismissal is exercised on canvas and image pixels in the dialog, inline viewer and fullscreen; loading/error states, internal disabled-item clicks, repeated right-clicks, mixed keyboard invocation, captured dragging and simulated touch long-press/tap cover the dismissal boundary rather than just its state callback.

The existing file-workbench HTML preview development suite also guards the SDK import boundary. Image actions import the browser client entry, not the root SDK export that loads Node server helpers; production tree-shaking alone did not expose that regression.

Resource-opening and workbench-view fixtures resolve both platform import forms to their existing host adapters and assert successful rendering at bootstrap. A missing context now fails at its cause rather than timing out every downstream action against a blank page.

The viewer fixture also covers pending-entry cancellation before modal dismissal, repeated activation, rejection followed by a successful retry, unsupported capability and deactivation before a real fullscreen request resolves. It controls only request settlement or capability at the browser API boundary; accepted requests and exits use the real browser implementation. Assertions wait for API completion and the owned overlay's dismissal separately, so a tooltip consuming Escape is not mistaken for a stuck fullscreen request. These focused checks do not establish package-wide coverage or replace CI; assertions and package thresholds remain unchanged.

Isolated Desktop acceptance covers message-gallery navigation, Files and Attachment viewing, source-sized native clipboard images, both themes, a 640 × 420 window, real 200% page zoom, extreme image aspect ratios and HTML fullscreen focus. Native save-sheet cancellation and on-disk completion remain unverified because the available native observation channel cannot inspect that sheet. Touch interactions have browser regression coverage, not physical touch-device acceptance.

A minimal native Electron fixture mounts the real viewer with production window chrome, Chromium configuration and fullscreen permission policy. Trusted pointer and keyboard input cover toolbar/menu exit, gallery navigation, reload, retained-view deactivation, immediate and repeated Escape, and HTML fullscreen inside a window already in native fullscreen. The fixture observes fulfilled browser promises, DOM ownership and both HTML/native enter/leave events; macOS transitions require their [native completion events](https://www.electronjs.org/docs/latest/api/browser-window#winsetfullscreenflag) and rendered geometry before the next pointer action. Delaying delivery of an already-approved permission result separately verifies inactive ownership without widening the permission policy. Immediate Escape also passes with the unmodified synchronous permission callback, and cancelling HTML entry preserves preexisting native fullscreen.
