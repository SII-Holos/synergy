# Decision Record: Capture hidden Browser pages from a new Chromium surface

Status: implemented

## Problem

A detached native Browser page can have correct document dimensions and a native parent while its CDP screenshot either waits indefinitely or immediately returns an empty image. In the pinned Electron 44.9.0 / Chromium 152.0.7977.167, the default screenshot path waits for frame presentation. Separately, constructor background preferences do not guarantee that the mounted renderer has entered hidden painting: a traced first-capture failure had no registered target frame sink. Geometry and successful JavaScript evaluation therefore do not establish a usable screenshot surface. The investigation and evidence limits are recorded in the [postmortem](../../../postmortem/0093-hidden-browser-capture-presentation.md).

## Decision

Desktop enables Chromium's `CDPScreenshotNewSurface` before Electron becomes ready. `configureDesktopChromium` owns this process-level setting and is called by both the production entry and the real native smoke wrapper. It preserves other enabled features and existing feature parameters, is idempotent, and rejects late configuration or an explicit conflicting disable instead of silently leaving the required path inactive. This is a native-engine compatibility setting, not a new product feature or a test-only flag.

The upstream path requests a new surface and copies its next repaint without waiting for the legacy presentation callback. The page pool also reapplies its existing `backgroundThrottling: false` immediately after parenting the native view, for both human attachment and hidden capture leases. Electron applies that setting to the current renderer and synchronizes its platform view with hidden painting. It never toggles the policy to true, shows or focuses the page, or creates another browsing context. The pinned upstream sources are cited beside both implementations.

Browser Core retains its full-page, clip and target algorithms. Capture reference counting, viewport transitions and operation deadlines remain unchanged. There is no frame-subscription readiness cache, extra wait, screenshot retry or parallel capture implementation.

The existing native page-pool fixture checks nine captures across detached, fixed, attached and fit/detach transitions, renderer recovery, first capture after human presentation, and two cross-site renderer replacements without pool-generation replacement. Each capture changes a 2048-CSS-pixel document, checks exact PNG dimensions at the measured device pixel ratio and fresh top/bottom pixels, and verifies native membership, visibility, identity, focus and absence of page visibility/focus events. Direct tests retain concurrent leases and failure cleanup and cover mounted drawing policy plus startup feature preservation, repeated calls, timing and conflicting flags.

## Alternatives considered

**Disable capture beyond the viewport or remove the clip.** Linux controls still stalled. These changes also risk altering full-page or target semantics and do not address the presentation callback.

**Replace CDP capture with Electron `capturePage`.** A native probe failed with `UnknownVizError`; the direct-copy API also does not provide CDP's full-document geometry algorithm. Viewport resizing or stitched scrolling would introduce unrelated layout and concurrency behavior.

**Show the page, recreate it, retry or extend the deadline.** These approaches would either violate human presentation ownership or hide the unresolved operation. No such fallback is added.

**Enable the feature only in CI.** That would leave production on the reproduced failing path and make native acceptance unrepresentative.

**Use the feature without reactivating mounted drawing.** This removes the legacy presentation dependency but leaves the observed first-capture empty-image failure and macOS human-presentation frame stall.

**Use only mounted drawing activation.** The isolated Linux control still stalled on its second full-page capture with the legacy screenshot path.

**Subscribe to a frame before every capture or cache initialization per renderer.** Repeated subscription stalled on Linux after the first successful capture. The smaller mounted-policy correction passed the expanded cross-platform fixture without any subscription or readiness state.

**Toggle background throttling on and off.** Both platform probes emitted two observable `visibilitychange` events. Reapplying false avoids that policy transition.

## Consequences

The change selects an upstream path that is default-off in the pinned engine. Electron upgrades must recheck its existence, default and behavior through the same real screenshot regressions before removing or changing the setting. An explicitly conflicting Chromium flag fails startup with its cause rather than being overwritten.

Local macOS and software-rendered Linux evidence does not establish Windows, physical Linux GPU, minimized-window or whole-window presentation acceptance. Immediate empty-image failures and presentation waits remain separate failure modes; the original CI pending operation was not traced. CI results and native fullscreen acceptance remain separate requirements.
