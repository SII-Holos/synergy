# Review Opaque Resource Keys

## Executive summary

Installed Review navigation failed when a retained change's compound operation key reached a CSS attribute selector. The shared List and its upstream collection dependency both assumed selector-safe keys. Fixing only the visible local selector left the actual Accordion interaction broken. Verification must exercise the complete interaction with real domain identities, including transitive controls.

## Summary

Workspace-aware change history keeps operation, Workspace and file identity in a composite key. Initial rendering and restored content could appear correct, but selecting another operation and expanding its row raised a selector SyntaxError. A completed backend persistence run therefore did not establish usable Review navigation.

## Timeline

- Installed acceptance found the failure while switching between two retained edits of the same file.
- A production-bundled List regression reproduced unsafe current-selection and keyboard-selection queries. Escaping them and cancelling stale scrolling made those tests pass.
- Repeating the original installed interaction still failed. The served artifact contained the List correction; tracing the transitive Accordion implementation found additional unescaped selectors in Kobalte.
- A second browser fixture reproduced the dependency failure through the actual shared Accordion and Tabs using both of Kobalte's published module forms. The dependency patch preserves raw keys while escaping their selector representation. The same keyboard checks exposed missing collection focus state in Accordion. Native selectable-item focus marks the collection active; content-entry tests prevent a broader root handler from stealing focus from editable descendants.

## Root cause

Changing resource identity changes every consumer of that identity, including upstream accessibility and focus-management code. Source-only searches found the local interpolation but did not establish that a dependency treated the same value safely. Component rendering, backend history checks and the List-specific regression each covered a narrower path than the user interaction.

An injected selector fragment can match another row without throwing, so absence of exceptions alone is insufficient. Tests must verify the exact focused, selected and expanded item as well as the raw callback value.

## Guardrails added

- [List browser tests](../../packages/ui/test/components/list-key-navigation.browser.test.ts) verify exact-row scrolling, selection and deferred cleanup for compound and special-character keys.
- [Collection browser tests](../../packages/ui/test/components/collection-key-navigation.browser.test.ts) verify pointer and keyboard interaction, controlled state, uncontrolled defaults and both dependency entrypoints.
- [Dependency patch provenance](../../patches/README.md#kobalte-collection-keys) binds the correction to its installed version and defines upgrade verification.
- [Frontend development guidance](../../.synergy/skill/develop-frontend/SKILL.md) requires following opaque keys through transitive controls.

## Lessons

A passing regression proves its exercised path. Repeat the original installed interaction after every fix, and keep backend persistence success separate from complete product acceptance.
