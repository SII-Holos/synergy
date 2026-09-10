# Decision Record: Keep `--prompt-height` measuring the dock that the async shell swap mounts

Status: implemented

## Problem

The session scroll-to-bottom button was obscured by the composer on desktop narrow views. The desktop offset is `md:bottom-[calc(var(--prompt-height,8rem)+16px)]`, so the button only clears the z-50 prompt dock when `--prompt-height` carries the dock's measured height. Runtime geometry in an isolated instance (900 px viewport) showed `--prompt-height` unset while the dock occupied ~221 px: the button fell back to the 8 rem (128 px) offset and slid under the dock overlay. Wide views hid the defect because the centered composer card leaves side whitespace where the button lands; a narrow session pane extends the card beneath the button and the overlap becomes visible.

The measurement itself was dead: `session.tsx` observed the dock via `createResizeObserver(() => promptDock, ...)` where `promptDock` was a bare `let`. The dock mounts through the async plugin-shell swap (`ShellSurface` resolves its shell through `createResource`), so the observer's internal effect ran once at setup with the variable still `undefined`; the later `promptDock = element` assignment is invisible to a non-reactive read and the observer never subscribed to anything. The mobile branch (`bottom-16`) never depended on the variable, which is why only desktop offsets regressed.

## Decision

Hold the observed dock element in a signal so the resize observer resubscribes whenever the dock (re)mounts:

- `apps/web/src/components/session/prompt-dock-height.ts` exports `createPromptDockHeight(onHeight)`: a `createSignal`-backed mount handle plus `createResizeObserver(dock, ({ height }) => onHeight(Math.ceil(height)))`. Signal reads inside the observer's diff effect make late mounts and shell swaps both observable.
- `session.tsx` wires `composerLayout.mount` to `dockHeight.mount` and keeps the existing height consumer unchanged (store write plus the pinned-at-bottom re-scroll when the scroller was already within 10 px of the bottom).

The regression net is `apps/web/test/components/session/prompt-dock-height.dom.test.tsx` (registered in `apps/web/script/test.ts` `playwrightIsolated`): it drives the real helper in Chromium through late mount → resize → shell swap (keyed `Show` rebuild, the same DOM churn the shell resource causes) and renders the real `DefaultSession` layout to assert its computed `--prompt-height`, including fractional-height ceiling. The fixture owns its observer through the Solid component lifecycle and calls mount cleanup during shell replacement.

## Alternatives considered

**Raise the `8rem` fallback to a larger fixed value.** Rejected: the dock height varies with the new-session greeting, inline decision surfaces, dock links, and the status bar; any fixed fallback can still be covered, and the mobile band geometry from the [inbox-band fix](2026-09-04-mobile-inbox-band-over-composer.md) already relies on the mobile/desktop split staying as-is.

**Lift the button above the dock's z-50 layer.** Rejected: it treats the symptom — the button would visually float over the composer shell and collide with the inbox trigger band instead of being covered by it.

**Re-measure on a timer or on session change.** Rejected: polling replaces a one-line reactive subscription, still misses shell swaps mid-session, and burns layout reads.

## Consequences

- `--prompt-height` tracks the real dock height across initial mount and shell swaps; the scroll-to-bottom button and the conversation bottom padding (`md:pb-[calc(var(--prompt-height,10rem)+96px)]`) position from measured geometry again. Verified at 900 px: the variable reports `161px` against a 160.8 px dock and the button bottom clears the dock content top by ~12 px.
- The dock-observation contract is now pinned by a real-browser suite instead of relying on the wiring happening to be reactive.
- The observer callback still receives the content-box height (ceil'd), matching the pre-existing calibration of the fallback values.

The exact observer module is exempted from Bun line accounting because its regression executes the real Vite-compiled helper in Chromium. The browser tests remain required and exercise delayed mount, resize, replacement and fractional height through the rendered session layout. Package coverage thresholds are unchanged.
