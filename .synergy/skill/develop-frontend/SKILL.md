---
name: develop-frontend
description: Implement or review Synergy Web and shared UI changes across packages/app and packages/ui. Use for components, contexts/stores, navigation, settings, dialogs, workbench surfaces, semantic icons, themes, responsive behavior, accessibility, frontend API calls, event sync, and product interaction changes.
---

# Develop the Frontend

## Read the Contracts

1. Read `packages/app/AGENTS.md` and [Web product contract](../../../packages/app/PRODUCT.md).
2. Read [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) for contexts, snapshots, events, streaming, composer intent, or loaded buckets.
3. Read [Browser runtime](../../../docs/architecture/browser-runtime.md) for Browser UI or Desktop/Web presentation changes.
4. Load `change-server-api` when the UI needs a new or changed server contract; load `add-tool` for tool-card presentation.

## Preserve State and API Ownership

1. Use stores for coherent keyed collections and signals for independent scalar state.
2. Apply entity updates with targeted setters and `reconcile`; do not replace a whole stored object for a one-field event.
3. Keep derived values one-way. Preserve composer resolution as explicit draft → session default → fallback; only explicit user choices persist upward.
4. Use generated SDK methods for ordinary internal HTTP routes. Keep raw browser transports only for WebSocket/EventSource/WebRTC, external URLs, platform fetch injection, and browser file/blob/download flows that the SDK should not represent.
5. Preserve Scope/directory parameters, authentication, error semantics, asset URLs, event `seq`/`epoch`, replay, and loading/error states.

## Use Semantic Icons

Non-tool product UI expresses meaning through `packages/ui/src/components/semantic-icon.tsx`.

1. Name the user-facing meaning before choosing a glyph.
2. Reuse an existing token only when the new control has the same meaning. Similar appearance or location is not enough.
3. Add a new semantic token before using an icon for a new product entity, navigation concept, state, setting, command, or action.
4. Choose a built-in glyph that is not already mapped to another semantic token. If two meanings truly require the same glyph, make that equivalence explicit and add a focused test instead of allowing accidental reuse.
5. Render through `getSemanticIcon(token)` and type stored metadata as `SemanticIconTokenName`.
6. Keep raw icon names inside base icon controls, file-type/icon registries, tool-card plumbing, or plugin-provided icon paths. Tool icons follow `add-tool`, not the product semantic-token registry.

Before handoff, scan the token map for duplicate glyph values and inspect nearby UI for raw product icon literals.

## Preserve Product Presentation

1. Reuse shared workbench, dialog, form, toolbar, and surface primitives before creating local variants.
2. Preserve polarity: dark content/selection surfaces step brighter inward; light surfaces step darker inward.
3. Use semantic color/type/spacing tokens. Reserve state colors for real state rather than decoration.
4. Keep controls labeled, keyboard reachable, focus-visible, WCAG AA, reduced-motion safe, and usable at narrow widths.
5. Implement loading, empty, error, disabled, and reconnect states as first-class behavior.
6. Update `PRODUCT.md` when an interaction or visual rule should survive refactors.

## Verify

1. Run the narrow component, model, or context test first.
2. Run:

```bash
bun run --cwd packages/app typecheck
bun run --cwd packages/ui test
bun run --cwd packages/app build
```

3. Inspect both themes, keyboard/focus, narrow layout, and loading/error behavior in an existing app or isolated second runtime.
4. Exercise Desktop when native Browser, window chrome, protocol, or Electron behavior changed.
5. Finish with `bun run quality:quick` when the change is ready for repository review.

## Handoff

Report state ownership, API path, semantic icon token, shared primitives, accessibility states, tests, visual checks, and any durable `PRODUCT.md` or Skill update.
