# Decision Record: Dead status-color token references

Status: implemented

## Problem

Ten app CSS files referenced status-color custom properties that no theme defines: `--text-critical`, `--text-warning`, `--text-success`, `--text-critical-base`, `--text-warning-base`, `--surface-critical-soft`, `--surface-warning-soft`, and `--surface-success-soft`. An undefined custom property computes to the property's initial value, so error text, warning banners, and danger menu items silently rendered uncolored or invisible in every theme. The existing `css-token-integrity` test validated only an enrolled list of files, so these references were never caught.

## Decision

Split the replacements by rendering context so each token's contrast guarantee matches where it is used:

- **Text on tinted status surfaces** (consent/marketplace banners, plugin state pills, note waiting states, file-workbench banner) uses the paired families the theme generator already contrast-validates at 4.5:1: `--text-on-critical-base` / `--text-on-warning-base` / `--text-on-success-base` on `--surface-critical-weak` / `--surface-warning-weak` / `--surface-success-weak`.
- **Bare error text on ordinary, untinted surfaces** (settings input errors and logout action, sidebar archive item, session-inbox discard action, workbench error text) uses the standalone `--text-error` role, which is resolved from the error ramp for exactly this purpose rather than being validated only against a critical tint.
- **Indicator graphics** keep the icon ramp: the subagent retry ring uses `--icon-critical-base`.
- **Session transition status icons** sit on `--surface-*-weak` fills, so their foregrounds use the paired `--text-on-*-base` tokens (which clear the 4.5:1 pair checks) instead of the independent `--icon-*-base` ramp that measured below the 3:1 non-text threshold on those fills.

Extend `packages/ui/test/css-token-integrity.test.ts` with a guard that scans every app/ui css, ts, and tsx source file for the eight dead names, instead of enrolling files into per-file coverage lists.

## Alternatives considered

**Define the missing tokens in the theme.** A parallel critical/warning text family would duplicate the existing `text-on-*` and `icon-*` families the theme generator already contrast-checks, growing the token surface instead of shrinking it.

**Use `--text-on-critical-base` everywhere.** That token is contrast-validated only against `--surface-critical-weak`; on untinted settings/surfaces a custom theme could pick a critical tint whose readable foreground is indistinguishable from the normal background, making bare error text disappear. The standalone `--text-error` role exists for exactly the untinted case.

**Extend the per-file coverage lists.** The phase lists kept missing new files, which is how these references survived; a fixed dead-name scan over the whole source tree does not depend on remembering to enroll each file.

**Fix only the sidebar menu item that surfaced the bug.** The same dead names appeared in nine other files; a one-off fix would leave the guard unable to lock out the rest.

## Consequences

Status text and banners now render their intended colors in light and dark themes, at the cost of small visible changes on surfaces that had been silently uncolored (the sidebar archive item, consent and marketplace error banners, plugin state pills, session transition icons, note waiting states, the file workbench banner, and workbench error text). The transition-card icon fills also switch foregrounds to the paired tokens, which shifts their hue slightly but keeps every status pairing inside the generator's contrast checks. A wider audit also surfaced older dead-token families (`--icon-weak`, `--icon-strong`, `--surface-muted`, `--surface-raised`, legacy `--color-*` names) that predate this change and remain follow-up work; the guard intentionally scopes to the status-color class to keep this change reviewable.
