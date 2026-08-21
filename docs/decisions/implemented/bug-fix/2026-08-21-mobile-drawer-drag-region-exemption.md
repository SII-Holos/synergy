# Decision Record: Exempt mobile drawer headers from the Electron drag region

Status: implemented

## Problem

On frameless Electron windows (non-darwin custom chrome), the always-rendered 36px titlebar band is a `-webkit-app-region: drag` region whose native hit-test swallows pointer events on anything overlapping it, regardless of DOM ancestry or z-order. The mobile navigation drawer and mobile tools drawer are full-viewport `fixed` overlays whose header rows — logo link plus close button — paint over that band on narrow (<768px) windows, leaving each close button effectively unclickable (it overlaps ~87.5% of the band). The first fix attempt used an inline `style={{ WebkitAppRegion: "no-drag" } as any}`, but that style never reaches the DOM in Solid: `babel-preset-solid` serializes static style objects verbatim into template HTML (`style=WebkitAppRegion:no-drag`, an invalid declaration the CSS parser drops), and the runtime `style()` helper passes object keys to `setProperty("WebkitAppRegion", ...)`, which CSSOM lowercases and silently rejects. camelCase vendor-prefixed keys are a React convention; Solid performs no key transformation on either path.

## Decision

Exempt both drawer header rows through a shared CSS class rather than inline styles. `src/components/app-shell/mobile-drawer.css` defines `.mobile-drawer-header { -webkit-app-region: no-drag; }` and is imported by both `mobile-drawer.tsx` and `mobile-tools-drawer.tsx`, mirroring the existing `__brand`/`__controls` exemptions in `desktop-window-chrome.css`. The property is inert in non-Electron browsers. `test/components/app-shell/mobile-drawer-drag-region.test.tsx` mounts both drawers through the real Solid compiler (Playwright plus a Vite fixture) and asserts the computed `-webkit-app-region` resolves to `no-drag` on both header rows and that the close buttons still dismiss; Electron's native hit-test itself is not reproducible headlessly, so the applied property is the verified proxy.

## Alternatives considered

**Inline style with the dash-case string key** (`style={{ "-webkit-app-region": "no-drag" } as any}`) applies correctly on both Solid compile paths but still requires a cast because csstype does not carry the property, and it scatters the exemption per element. The shared class keeps the geometry rationale in one place and matches the titlebar pattern.

**Inline camelCase `WebkitAppRegion`** (the original attempt) is a silent no-op in Solid for the reasons above; it works in React only because React's style hyphenation special-cases a leading capital.

**Inline camelCase `appRegion`** hyphenates cleanly in React but fails both Solid paths: static serialization emits `style=appRegion:no-drag` (invalid declaration name) and `setProperty("appRegion")` lowercases to `appregion`.

## Consequences

Close buttons on both mobile drawers are clickable again on frameless Windows/Linux windows; macOS is unaffected either way (native chrome keeps an 18px band that only grazes the button). The new suite is registered in `playwrightIsolated` in `packages/app/script/test.ts` because bun's parallel workers reap sibling suites' Chromium processes. Durable rule: Solid inline style objects must use dash-case string keys — camelCase keys are silently dropped on both compile paths, and green CI cannot catch the loss.
