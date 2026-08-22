# Decision Record: Render the error-page version from the Show accessor value

Status: implemented

## Problem

The fatal-error and initialization-error footers print the app's build identity next to the issue link. Both rendered `Version: () => { if (!k(r)) throw hn("Show"); return n() }` — the minified source of an accessor function — instead of the version string. Both pages used the callback form of Solid's `<Show>` and passed the callback parameter, which is an accessor function rather than a value, directly as an ICU interpolation value for the Lingui label; Lingui stringifies non-string values, so the rendered text became the accessor's own source. The defect was invisible in dev review and only surfaced in minified production builds, exactly where users read the footer while reporting a crash.

## Decision

Both error footers call the accessor (`version()`) before passing it to the i18n version label. The rendering path is locked by a Playwright DOM fixture (`packages/app/test/pages/fatal-error.dom.test.tsx`, registered in the serial Playwright batch) that asserts the literal version text, the buildLabel-over-version preference, and the same path on the initialization-error page; against the unfixed code the fixture fails by rendering the accessor source. The Solid rule — callback children of non-keyed `<Show>` and `<Index>` receive accessors that must be called before interpolation, formatting, or attribute binding, while `<Show keyed>` and `<For>` pass the raw value — is recorded in the `develop-frontend` skill so the mistake class cannot silently recur.

## Alternatives considered

- **Drop the callback form and read `platform.buildLabel ?? platform.version` inline in the JSX** — rejected: it loses the non-null narrowing the callback provides and duplicates the fallback chain at each interpolation site.
- **Teach formatters or the i18n layer to call function values defensively** — rejected: the defect is a misuse at the call site; masking it in shared formatters would hide genuine function-valued bugs elsewhere and add a fallback the type system already forbids.
- **Cover the footer with a unit test on the presentation memo only** — rejected: the memo never sees the accessor; only a DOM-level assertion observes the interpolated footer text.

## Consequences

- Both error footers render `Version: <version or buildLabel>` again; the remaining i18n interpolation sites were audited and none passes an uncalled accessor.
- The error pages gain DOM coverage, so footer regressions fail the app suite instead of waiting for the next field crash report.
- `packages/app` gains one serial Playwright fixture; Chromium-launching suites keep running after the main batch, and the covered page components stay outside bun coverage instrumentation exactly as before.
