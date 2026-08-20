# Decision Record: Contain renderer memory growth from detached DOM and duplicated data strings

Status: implemented

## Problem

Electron renderer heap snapshots over five days showed node counts growing from 1.9M to 39.7M (a 20x increase) alongside daily UI lag. Class-level aggregation of the complete 08-17 snapshot (22.2M nodes, 949.8MB self size) identified four retention surfaces: 98% of activity-step / compact-reasoning / session-turn / markdown DOM nodes sat in detachedness bucket 2 (removed from the document but still referenced), the Solid reactive graph carried 628k AccessorPairs and 1M ContextCells, 96k identical `"@ai-sdk/openai-compatible"` and 16k `"reasoning.encrypted_content"` strings were duplicated per record from provider/message payloads, and 492k SVG wrapper nodes accumulated from per-render icon DOM.

## Decision

Fix the retention surfaces that have a clear owner and a narrow change:

- **Tooltip listener cleanup**: `Tooltip` attached `focus`/`blur` listeners to its children in `onMount` with no removal. Every activity step wraps its audit icon in a Tooltip, so removed rows kept their DOM reachable through the listener closures. Listeners are now attached through a new `tooltip-focus.ts` helper that returns a detach closure, registered with `onCleanup`.
- **Frozen terminal activity projections**: `makeStep` rebuilt `ActivityStepProjection` objects on every projection pass (streaming deltas, settle flip, window rewrites). Completed/error tool parts without a pending approval are now cached in a module-level `WeakMap<ToolPart, ActivityStepProjection>` and reused; pending steps and approval steps still re-derive because their state changes with stream/permission events. WeakMap entries collect with their part, so eviction still releases them.
- **String interning at the store boundary**: new `string-intern.ts` interns provider model api fields (id/npm/url), variant `include` entries, user message `system` prompts, and system-origin text parts with a bounded (512-entry FIFO) value table before `reconcile` writes them into the store. Wired into every provider write point (global list, per-scope refresh, targeted refresh, bootstrap snapshot) and every message/part write point (WS `message.updated` / `message.part.updated`, HTTP messagePage, compaction reload). User-origin text and streaming deltas are never interned.
- Verified no-code items: kobalte `Collapsible.Content` already lazy-mounts by default (`shouldMount = forceMount || isOpen()`), so folded activity steps do not render their tool bodies; SVG icon sprite-ification was evaluated and deferred (core render path change with plugin-icon innerHTML and lucide Dynamic branches, low relative payoff).

## Alternatives considered

- **Interning in the SDK response layer** — rejected: the SDK package ships generated types and a thin client; responses flow through raw `JSON.parse` on the WebSocket path anyway, so the store boundary is the only point that covers all entry paths without touching generated code.
- **Backend deduplication** — rejected: provider metadata and message schemas are public API contracts; changing them does not stop the frontend from re-copying strings on every refresh.
- **Snapshot-level store field for frozen projections** — rejected: adds a denormalized display field and a new reconcile path; a WeakMap keyed by part identity achieves the same reuse with no store ownership changes.
- **Icon sprite symbolization** — deferred: the icon render path branches between plugin innerHTML SVG and Lucide Dynamic components; a sprite rewrite is a visual-regression-risk change whose payoff is bounded by the other fixes, tracked as follow-up.

## Consequences

Detached DOM retention drops by removing the listener-closure path that kept removed activity rows reachable, and settled steps stop allocating fresh projection objects per pass. Identical provider/message strings share references after the first sighting, capped at 512 entries with FIFO eviction so the table cannot grow with session history. All changes preserve observable behavior: tooltips still respond to focus/blur, projection outputs are reference-equal only for terminal no-approval steps whose inputs are stable by definition, and interning is semantically transparent (equal values, one reference). Coverage: `tooltip-focus.test.ts` (detach contract), `string-intern.test.ts` (sharing and no-op cases), `session-turn-activity.test.ts` freezing cases; the `tooltip-focus` suite runs in the isolated batch because it installs a jsdom window.
