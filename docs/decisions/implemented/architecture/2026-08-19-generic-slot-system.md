# Decision Record: Generic slot system for plugin UI contributions

Status: implemented

## Problem

Plugin UI contributions grew into eleven bespoke registries with hand-rolled array+listener or Map bookkeeping, each with its own lifecycle, duplicate-id check, and sort logic. Adding a new host surface (sidebar footer, session empty state, app footer) meant either another bespoke registry or reaching into private host components. At the same time, users asked for "completely different" themed surfaces (parchment textures, brushed metal) that the color-only theme contract cannot express — those are UI surfaces, not color tokens. Synergy needed a single, typed extension mechanism for host-declared UI positions, and a way for plugins to contribute styled surfaces without extending the theme JSON contract.

## Decision

Introduce a generic slot system as the unified registration and rendering backbone for plugin UI contributions, additive to the public plugin contract:

- **Public contract (`packages/plugin`)**: new `ui.slot` contribution kind (`slot()` helper, `SlotContribution`, zod schema, `descriptor.ts` compile branch, `PluginSlotSurfaceContext`). A `ui.slot` declares a `slot` name (e.g. `sidebar.footer`) and an optional `when: { session }` visibility condition. Additive only — existing manifest schemas, helpers, and component props are unchanged, and the UI API version is not bumped.
- **Host infrastructure (`packages/app`)**: `SlotRegistry<E>` — a generic, typed, per-slot-name registry (register → idempotent disposer, stable order→label→id sort, `clear(pluginId)`, subscribe) — plus `SlotOutlet`, a unified lazy renderer (disposed guard, shared `PluginErrorBoundary`, empty-state fallback, `only` filter for single-entry surfaces). The shared `pluginSlots` instance backs generic `ui.slot` contributions.
- **Five host-declared outlets**: `settings.section`, `sidebar.footer`, `session.header.actions`, `session.empty`, `app.footer`. Each renders a `SlotOutlet` with the pre-existing UI as fallback, so behavior with no plugins is unchanged.
- **Unification**: the four hand-rolled array+listener registries (composer slot, message slot, composer extension, selection extension) and the three `SurfaceRegistry`-based facades (settings, navigation, workbench) now sit on `SlotRegistry` thin facades. Public APIs, entry shapes, ordering, and disposer semantics are preserved exactly — read paths strip the internal `slot` key so callers see the same object shape as before.
- **Theme surfaces stay out of the theme contract**: textured surfaces (parchment, metal) are expressed as plugin components with plugin-owned CSS, registered into slots — not as theme JSON fields.

## Alternatives considered

- **Extend the theme JSON contract with design tokens / materials / custom CSS** — rejected: it would require schema migration, strict-zod churn, `synergy-skin-cache-v1`/`DesktopSkinStateV2` upgrades, and a WCAG boundary for textures, while the request was for UI surfaces, not color semantics. The surface-slot path covers it with existing trusted-component + CSS machinery.
- **Phase-3 sandboxed theme CSS engine** — rejected: highest maintenance cost (sanitization, scoping, Desktop startup compatibility) with no consumer that the surface-slot path does not already serve.
- **Leave the eleven registries bespoke and only add new outlets** — rejected: keeps two parallel extension mechanisms and contradicts the "one clean extension path" goal.
- **Full dsh-style slot taxonomy (single/list/keyed/chain + selector election)** — rejected as over-engineering for v1: no consumer needs chain/selector today. The unified registry supports list and single via `only`; chain can be added later when a real consumer appears.

## Consequences

- One registration/lifecycle model covers every plugin UI contribution; new host surfaces are a `<SlotOutlet>` call plus a slot-name entry in the host allowlist.
- Plugins can now ship "styled surfaces" (e.g. a steampunk parchment footer) entirely through the public plugin path, without touching the theme contract, WCAG guarantees, or Desktop startup skin.
- Existing plugins are unaffected: all public manifest/helper/props contracts are byte-identical; internal registries were reimplemented under the same API.
- The host must declare a slot before plugins can target it (`HOST_SLOTS` allowlist) — unknown slot names are reported as contribution errors, keeping the slot vocabulary a host-owned contract.
- The `SlotOutlet` renderer is deliberately JSX-free in its source file so bun:test can exercise it directly (bun's test transform compiles `.tsx` JSX to React.createElement in this harness).
