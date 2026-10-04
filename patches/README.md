# Dependency patches

## Kobalte iframe focus

Provenance: Kobalte utils 0.9.1, including its pinned [tabbable traversal](https://github.com/kobaltedev/kobalte/blob/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/utils/src/tabbable.ts) and [active element lookup](https://github.com/kobaltedev/kobalte/blob/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/utils/src/dom.ts).

Local adaptation: [the pinned patch](@kobalte%252Futils@0.9.1.patch) preserves loading iframe focus until its document body exists and checks element visibility against the owning window's constructors. Both published ESM and CommonJS entrypoints carry the same correction. This prevents preview loading from breaking menu focus and includes loaded iframe controls in keyboard traversal.

[Real browser regression](../packages/ui/test/components/iframe-focus.browser.test.ts) streams a same-origin document without a body, checks pending focus, then completes the document and verifies native keyboard navigation. Keep the patch until an upgraded dependency passes this regression without it; verify a fresh frozen-lockfile install before accepting an upgrade.

## Kobalte collection keys

Provenance: [Kobalte core 0.13.11 source](https://github.com/kobaltedev/kobalte/tree/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/core/src), including its [list keyboard delegate](https://github.com/kobaltedev/kobalte/blob/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/core/src/list/list-keyboard-delegate.ts).

Local adaptation: [the pinned patch](@kobalte%252Fcore@0.13.11.patch) escapes opaque collection keys before attribute-selector lookup in selection, keyboard navigation, Tabs and Combobox. Native selectable-item focus also marks its collection active so Accordion arrow keys move DOM focus without redirecting focus from editable content. Both published JavaScript and JSX entrypoints carry the same corrections. Public values, callbacks, DOM attributes and persisted resource identities remain unchanged; the package's licenses remain intact.

[Real browser regressions](../packages/ui/test/components/collection-key-navigation.browser.test.ts) exercise both entrypoints through shared Accordion and Tabs, including controlled updates, uncontrolled defaults, pointer activation and keyboard focus. Keep the patch until a replacement dependency passes these cases without it. Verify a fresh frozen-lockfile install before accepting an upgrade.
