# Dependency patches

## Solid ordered row retention

Provenance: [Solid 1.9.15 DOM renderer](https://unpkg.com/solid-js@1.9.15/web/dist/web.js) and its upstream [DOM array reconciliation](https://github.com/ryansolid/dom-expressions/blob/27a88bea8ffa97400bbcc66d380e40daed9e1cf1/packages/dom-expressions/src/reconcile.js).

Local adaptation: [the pinned patch](solid-js@1.9.15.patch) checks shared nodes' relative order in linear time. When that order is unchanged, it removes obsolete nodes and inserts only newly admitted nodes around the shared nodes. Shared rows never detach, preserving native focus and text selection when virtual paging changes its overscan direction or adds a disjoint range. Actual node permutations use the original reconciler. Development/production ESM and CommonJS entrypoints share the correction; SSR entrypoints and licenses remain unchanged.

[DOM regressions](../packages/ui/test/solid-ordered-rows.test.ts) cover focus, selection, ordered admission/removal and all five-row permutations through all four published entrypoints. [Conversation browser regressions](../apps/web/test/components/session/conversation-process.dom.test.ts) exercise real native paging, retained link focus and subsequent body growth or history backfill. Keep the patch until an upgraded dependency passes these cases without it, then remove it. Verify a fresh frozen-lockfile install before accepting an upgrade.

## Virtua Solid resize delivery

Provenance: [Virtua 0.42.3 resize observer](https://github.com/inokawa/virtua/blob/0.42.3/src/core/resizer.ts) and [upstream resize delivery issue](https://github.com/inokawa/virtua/issues/470).

Local adaptation: [the pinned patch](virtua@0.42.3.patch) queues the latest notification per target and publishes one Solid batch on the next animation frame. Notifications with zero width and height from targets without layout boxes are discarded during delivery, before a hidden target can reappear and overwrite its cached dimensions. Visible zero-size targets still publish. Frame publication checks connection and the mounted registry without querying `offsetParent`; visible fixed-position roots remain measurable. Solid lists keep native hit testing enabled during scrolling instead of toggling an inherited pointer-event style over their whole subtree. Unobserving a target drops its queued entry; disposal cancels the frame and clears pending entries. Both the published JavaScript and JSX Solid entrypoints carry the same correction. Other framework entrypoints and the package licenses remain unchanged.

[Real browser regression](../apps/web/test/components/session/conversation-process.dom.test.ts) checks nested process disclosure, delayed history hydration and viewport resizing without undelivered notifications, alongside reading anchors and retained content. Keep this patch until an upgraded dependency passes these cases through both entrypoints without it; verify a fresh frozen-lockfile install before accepting an upgrade.

## Kobalte iframe focus

Provenance: Kobalte utils 0.9.1, including its pinned [tabbable traversal](https://github.com/kobaltedev/kobalte/blob/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/utils/src/tabbable.ts) and [active element lookup](https://github.com/kobaltedev/kobalte/blob/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/utils/src/dom.ts).

Local adaptation: [the pinned patch](@kobalte%252Futils@0.9.1.patch) preserves loading iframe focus until its document body exists and checks element visibility against the owning window's constructors. Both published ESM and CommonJS entrypoints carry the same correction. This prevents preview loading from breaking menu focus and includes loaded iframe controls in keyboard traversal.

[Real browser regression](../packages/ui/test/components/iframe-focus.browser.test.ts) streams a same-origin document without a body, checks pending focus, then completes the document and verifies native keyboard navigation. Keep the patch until an upgraded dependency passes this regression without it; verify a fresh frozen-lockfile install before accepting an upgrade.

## Kobalte collection keys

Provenance: [Kobalte core 0.13.11 source](https://github.com/kobaltedev/kobalte/tree/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/core/src), including its [list keyboard delegate](https://github.com/kobaltedev/kobalte/blob/1bd4aaa7ad782b7ad03a9e4fd94565310dce08a0/packages/core/src/list/list-keyboard-delegate.ts).

Local adaptation: [the pinned patch](@kobalte%252Fcore@0.13.11.patch) escapes opaque collection keys before attribute-selector lookup in selection, keyboard navigation, Tabs and Combobox. Native selectable-item focus also marks its collection active so Accordion arrow keys move DOM focus without redirecting focus from editable content. Both published JavaScript and JSX entrypoints carry the same corrections. Public values, callbacks, DOM attributes and persisted resource identities remain unchanged; the package's licenses remain intact.

[Real browser regressions](../packages/ui/test/components/collection-key-navigation.browser.test.ts) exercise both entrypoints through shared Accordion and Tabs, including controlled updates, uncontrolled defaults, pointer activation and keyboard focus. Keep the patch until a replacement dependency passes these cases without it. Verify a fresh frozen-lockfile install before accepting an upgrade.

## Virtua Solid initial measurements

Provenance: [Virtua 0.42.3 measurement actions](https://github.com/inokawa/virtua/blob/0.42.3/src/core/store.ts).

Local adaptation: [the pinned patch](virtua@0.42.3.patch) exposes `initialSizes` on Solid Virtualizer and WindowVirtualizer. A finite positive size for every data item seeds the ordinary item-resize action before mounting; invalid arrays are ignored. The caller supplies measurements in data order at the current width and font. Both shipped Solid entrypoints and their declarations share the input. The scroll observer also reads the existing viewport offset on mount through the ordinary scroll and scroll-end actions, including WindowVirtualizer start position, without creating an input timer or disabling pointer events. The input avoids constructing an opaque internal cache to adopt a layout measured by a preceding renderer.

Virtua `restoreToIndex(index, offset)` synchronously accepts currently mounted content-box measurements through its existing resizer, consumes estimate compensation and commits one native-idle position. It has no imperative scroll waiter; identical-offset delivery retains public scroll callbacks without changing the native scroll direction. The mounted registry has one owner and releases entries on unmount/disposal. Both Solid entrypoints and declarations carry this contract. The compiled entrypoint is generated from the patched JSX using the installed `babel-preset-solid` DOM transform and Bun browser minification with `solid-js` and `solid-js/web` external.

Solid Virtualizer also batches initial content-box measurements of newly mounted, unmeasured rows after mount and disclosure preparation microtasks, before parent resize delivery can follow an estimated tail. Only connected targets with layout boxes participate; unobserve and disposal drop pending targets. All reads precede one resize publication. History prepend keeps the existing shift compensation and observer ordering; ordinary CSS resizes retain the frame-coalesced ResizeObserver path. Solid Virtualizer’s optional `observeContent(item)` predicate coalesces descendant content and inline-style changes into one animation-frame content-box measurement batch before paint, so late bodies and Markdown replacement publish their neighbouring offsets together. Only changed mounted rows are read; wrapper position writes are ignored. Accepting a content measurement discards an older queued resize for that target. The active outer conversation enables it for non-exiting body rows; content measurement is independent of animation readiness, while inactive views, automatic exits and nested lists retain their original scheduling. Opted-in body rows publish initial and changed sizes during history shifting through the existing shift compensation; otherwise late older replies can cover the retained anchor. Other initial rows retain their separate measurement ordering. Eviction and disposal disconnect content observers. [Cold body regressions](../apps/web/test/components/session/conversation-long-process.dom.test.ts) cover both Solid entrypoints, body-read bounds and cached-content reuse. [Following regressions](../apps/web/test/components/session/conversation-process-virtualization.dom.test.ts) compose real disclosure motion and automatic scrolling through both entrypoints and inspect every frame for overshoot or rebound; see the [admission decision](../docs/decisions/implemented/bug-fix/2026-10-12-measure-new-rows-before-following.md).

[Browser regression](../packages/ui/test/markdown-virtual.browser.test.ts) exercises the JavaScript and JSX entrypoints before their first paint and the real Markdown worker handoff. Keep this input until an upgraded dependency supports equivalent measured initialization and passes these checks after a fresh frozen-lockfile install.

## Virtua Solid measurement identity

Provenance: [Virtua 0.42.3 indexed size cache](https://github.com/inokawa/virtua/blob/0.42.3/src/core/cache.ts) and [Solid Virtualizer](https://github.com/inokawa/virtua/blob/0.42.3/src/solid/Virtualizer.tsx).

Local adaptation: [the pinned patch](virtua@0.42.3.patch) adds optional `itemKey` to Solid Virtualizer. Callers provide stable unique string or number identities. Before publishing a changed order, retained keys carry their measurements to the new indices; new keys start unmeasured and removed keys release their sizes. Cached offsets are invalidated together, including equal-length reorderings. Existing `shift` compensation still applies to history prepend. Conversation and inner process virtualizers opt in; other consumers retain their existing behavior. Both Solid entrypoints and the declaration share this contract.

[Measurement regressions](../apps/web/test/components/session/conversation-process-virtualization.dom.test.ts) check long retained rows through middle deletion, insertion, reordering and prepend through both entrypoints. [Disclosure regressions](../apps/web/test/components/session/conversation-process-disclosure.dom.test.ts) sample every frame with a long answer and retain its DOM identity. Keep the adaptation until an upgraded dependency preserves these invariants without it; verify a fresh frozen-lockfile install before accepting a replacement.

## Streaming Markdown consumed source spans

Provenance: [streaming-markdown 0.2.15 parser](https://github.com/thetarnav/streaming-markdown/blob/v0.2.15/smd.js).

Local adaptation: [the pinned patch](streaming-markdown@0.2.15.patch) optionally records compact affine source spans alongside the parser's text, pending-token and indentation buffers. Recursive consumption carries its original positions; parser-generated whitespace has no original position. Opted-in renderers receive source spans with text flushes and token starts. Whole appended deltas retain one parser call. Both the source and browser artifact implement the same hook, and the type declarations describe it. Existing renderers preserve their emitted tokens, text and attributes.

[Pure entrypoint regressions](../packages/ui/test/markdown-stream-provenance.test.ts) verify emitted bytes, consumed positions and split Unicode chunks through both artifacts. [Controller regressions](../packages/ui/test/markdown-stream.test.ts) verify source transfer, compact settled Text runs, selection endpoints and incremental grapheme work. Keep this patch until an upgraded parser exposes equivalent consumed provenance and passes the same cases after a fresh frozen-lockfile install; do not reconstruct parser consumption outside its owner.
