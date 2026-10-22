# Decision Record: One gesture per browser recovery state

Status: implemented

## Problem

The Desktop Browser surface replaced the whole page body whenever a page was not being presented: recovering the native host, a failed native recovery, or a suspended page. That state rendered a 36px mark, a 13px title, a paragraph of explanation, a 22px `size="small"` action, and a pill printing `browser.session.connectionStatus` verbatim.

Three separate problems met on one surface:

- The paragraph explained the mechanism instead of the outcome. A suspended page
  told the reader that resuming "reload[s] this address using its saved identity" and that "unsaved forms are not restored"; a recovering host said Synergy "is reconnecting to the browser" and that the reader could "retry now". Both sentences ask the reader to understand internal recovery semantics before they can act, while the action underneath already says what to do.
- The pill printed a raw protocol value. `connected` is transport state, not
  product copy: it is untranslated, unbounded in length, and duplicates the connection failure that `browser-panel.tsx` already reports in its own row.
- The action did not match the rest of the product. Every other whole-surface
  state — `fatal-error.tsx`, `error.tsx`, `server-connection-error.tsx` — uses `size="large"`. This one used `size="small"`, so the only control on an otherwise empty canvas was the smallest button in the app.

The stylesheet carried the same drift: `browser-empty-mark` set `color: var(--icon-weak)`, a token that does not exist in `theme.generated.css`, so the mark's icon color had silently fallen back to the inherited text color.

## Decision

A whole-surface state now owns exactly three things: one identity mark, one state name, and at most one action. `browser-surface.tsx` collapses the nested `Show` tree into one `empty()` memo returning `{ title, action? }` descriptors, so the state-to-copy mapping is a flat table instead of a tree of conditionals.

- The action is `size="large" variant="primary"`, matching the other full-page
  states. It is the instruction; the surface never explains how recovery works.
- The mark is a single 52px rounded square. The dead `--icon-weak` reference is
  replaced by the real `--icon-weak-base`, and geometry uses `--radius-xl` and `--font-size-base` rather than literals.
- The status pill and the `browser-empty-text` block are removed with their CSS.
  `waitingForSurface`, `resumeHint` and `nativeRecoveryHint` then have no reader and are removed from `messages.ts` and all three catalogs.
- Descriptors resolve through `lingui._(descriptor)` rather than `<Trans>`,
  because the extractor requires a literal `id` on `<Trans>` while the state name is chosen at runtime from a closed set of statically extractable descriptors.
- `nativeRecoveryAvailable()` is deleted. Its first conjunct compared
  `props.clientPresentation === "native"` against a prop whose type is the literal `"native"`, so it was always true; the remaining condition is `platform.browserNative`. The `recovering` prop then loses its only reader and is removed from the surface and its caller.

The rule is recorded where it survives refactors. `apps/web/PRODUCT.md` states that a whole-surface state is a mark, one state name and at most one action, that it never explains recovery, identity reuse or unrestored data, and that it never prints a raw status value. The first-class-state checklist in `.synergy/skill/develop-frontend/references/presentation.md` carries the same constraint plus its verification requirement: assert the state's own text nodes and action count in a real browser, not that some explanation exists.

## Alternatives considered

**Keep the explanation and shorten it.** Rejected because the sentence is only worth reading if it states what will be lost ("unsaved forms are not restored"), which is exactly the mechanism the action already implies; a shorter version restates the button label and costs a line for nothing.

**Move the explanation into a tooltip on the action.** Rejected because hover help would make the only control on an empty canvas discoverable only by pointer, and the text would still ask the reader to learn recovery semantics before acting.

**Keep the status pill but translate it.** Rejected because a translated value is still transport state, and connection failure already has its own reporting row; two surfaces claiming the connection would eventually disagree.

**Keep `size="small"` for density.** Rejected because this state replaces the entire page body. Density is a property of lists and toolbars, not of the one control on a blank surface, and the mismatch with the other full-page states is what made it read as a different product.

**Give each state its own component.** Rejected because the states differ only in their name and whether an action exists; one descriptor memo keeps the mapping readable and prevents the copy from re-growing per branch.

## Consequences

The surface no longer explains itself, so a caveat that genuinely belongs to a state cannot live here; it has to belong to the page it affects, where the failed-page row already reports its own error and recovery. The three removed message keys are gone from the catalog, so restoring that copy later means adding translated entries again rather than un-commenting a branch.

Validation: `apps/web/test/components/workspace/browser/browser-recovery-state.test.tsx` drives real Chromium through the recovering, failed, ready and suspended transitions. The recovering state asserts its name and zero buttons; the failed state asserts exactly one `Retry`; the suspended state asserts that the surface renders exactly `["Page suspended", "Resume page"]` as a text-node list, so any re-introduced explanation fails the test. `bunx tsc --noEmit` is clean for `apps/web`, `i18n:extract` and `i18n:check` pass without the removed keys, and `oxlint` reports the same seven pre-existing warnings as `HEAD`.
