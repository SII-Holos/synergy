# Decision Record: Dead status-color token references

Status: implemented

## Problem

Ten app CSS files referenced status-color custom properties that no theme defines: `--text-critical`, `--text-warning`, `--text-success`, `--text-critical-base`, `--text-warning-base`, `--surface-critical-soft`, `--surface-warning-soft`, and `--surface-success-soft`. An undefined custom property computes to the property's initial value, so error text, warning banners, and danger menu items silently rendered uncolored or invisible in every theme. The existing `css-token-integrity` test validated only an enrolled list of files, so these references were never caught.

## Decision

Replace each dead reference with the closest existing token family: `--text-on-critical-base`, `--text-on-warning-base`, and `--text-on-success-base` for status text; `--surface-critical-weak`, `--surface-warning-weak`, and `--surface-success-weak` for tinted backgrounds; and `--icon-critical-base` for the subagent retry ring, which is an indicator rather than text. Extend `packages/ui/test/css-token-integrity.test.ts` with a guard that scans every app/ui css and tsx source file for the eight dead names, instead of enrolling files into per-file coverage lists.

## Alternatives considered

**Define the missing tokens in the theme.** A parallel critical/warning text family would duplicate the existing `text-on-*` and `icon-*` families the theme generator already contrast-checks, growing the token surface instead of shrinking it.

**Extend the per-file coverage lists.** The phase lists kept missing new files, which is how these references survived; a fixed dead-name scan over the whole source tree does not depend on remembering to enroll each file.

**Fix only the sidebar menu item that surfaced the bug.** The same dead names appeared in nine other files; a one-off fix would leave the guard unable to lock out the rest.

## Consequences

Status text and banners now render their intended colors in light and dark themes, at the cost of small visible changes on surfaces that had been silently uncolored (the sidebar archive item, consent and marketplace error banners, plugin state pills, session transition icons, note waiting states, the file workbench banner, and workbench error text). A wider audit also surfaced older dead-token families (`--icon-weak`, `--icon-strong`, `--surface-muted`, `--surface-raised`, legacy `--color-*` names) that predate this change and remain follow-up work; the guard intentionally scopes to the status-color class to keep this change reviewable.
