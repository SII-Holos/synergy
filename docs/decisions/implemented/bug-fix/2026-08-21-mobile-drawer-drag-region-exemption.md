# Decision Record: Keep mobile drawer close buttons clickable over the Electron drag band

Status: implemented

## Problem

On frameless Electron windows (non-darwin custom chrome), the 36px custom titlebar is a `-webkit-app-region: drag` band whose native hit-test swallows mouse events for everything under it. The mobile navigation and tools drawers are full-viewport overlays (`fixed inset-0 z-[100]`, `md:hidden`) whose header rows — logo/title plus close button — sit on that band on narrow (<768px) windows, so the close buttons were effectively unclickable on Windows/Linux. The PR's original fix tagged the drawer header with an inline `WebkitAppRegion` style, which never reached the DOM in Solid (camelCase keys are dropped on both Solid compile paths). A follow-up marked the header rows with a `no-drag` CSS class instead: the property applied, but live Electron testing showed the left drawer's close button stayed swallowed while the right one worked — the right button only worked because it happened to overlap the titlebar's window-controls strip (`__controls`), a no-drag zone carved out from _inside_ the drag element's subtree. Electron's drag-region hit test ignores `no-drag` on non-descendant overlays; only carve-outs within the drag element's own subtree participate.

## Decision

While a drawer overlay is mounted, suspend the titlebars' drag region entirely. Both drawer roots carry a `mobile-drawer-overlay` marker class, and `mobile-drawer.css` applies `-webkit-app-region: no-drag` to `.desktop-window-chrome` and `.desktop-native-titlebar` under `body:has(.mobile-drawer-overlay)` within `@media (max-width: 767px)`. This is semantically correct: a mounted drawer is a modal that covers the titlebars completely, so window-drag affinity there has no value while it is open. The max-width gate matches the drawers' `md:hidden` breakpoint; because `:has()` matches hidden overlays too, the gate also releases the suspension when the window widens past the breakpoint with a drawer still logically open. The Playwright suite mounts the real drawers plus the real `DesktopWindowChrome` through the Solid compiler and asserts the titlebar's computed app-region flips `drag` → `no-drag` with either drawer open and back to `drag` when closed, alongside close-button dismissal.

## Alternatives considered

**`no-drag` on the drawer header rows (CSS class or inline style)** — applies cleanly but does not participate in the drag-region hit test from outside the drag element's subtree; live Electron testing showed a button over the pure drag band stays swallowed.

**Inline `style={{ WebkitAppRegion: "no-drag" } as any}` (the original PR)** — a React-ism; Solid drops camelCase style keys on both compile paths (static template serialization and runtime `setProperty`), so it never reached the DOM.

**A JS effect toggling a class on the titlebar components** — needs layout-context plumbing into the chrome components for no benefit over the declarative `:has()` selector.

## Consequences

Close buttons on both mobile drawers are clickable on frameless Windows/Linux windows. While a drawer is open on a narrow window the titlebar cannot drag the window — acceptable because the modal overlay covers it entirely. macOS native chrome participates too through `.desktop-native-titlebar`. Durable rule for future surfaces: a full-viewport overlay with interactive controls near the top band must suspend the drag source (or carve `no-drag` from inside the drag subtree); a `no-drag` overlay outside the subtree does nothing. The selector here is deliberately drawer-specific rather than generic. The Playwright suite stays registered in `playwrightIsolated` (`packages/app/script/test.ts`) because bun's parallel workers reap sibling suites' Chromium processes.
