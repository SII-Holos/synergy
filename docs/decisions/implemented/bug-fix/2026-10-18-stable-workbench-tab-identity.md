# Decision Record: Stable workspace tab identity

Status: implemented

## Problem

The workbench rendered tab rows with `For` over the tab object array. Solid diffs that array by reference, and every metadata write builds a new object for the changed tab: a Browser page title or URL update, a dirty flag, a restored resource. Each such write disposed and recreated that tab's DOM row. When the replacement landed between `pointerdown` and `pointerup`, the browser discarded the press and no `click` was delivered, so the tab never activated. A control experiment confirmed the mechanism: replacing a node between press and release drops the click, while `pointerup` still targets the new node. Loading and navigating Browser pages publish metadata continuously, which is why the failure appeared intermittent — "the tab does nothing, click it again".

## Decision

The tab run is keyed by tab id. `For` iterates `state().tabs().map((tab) => tab.id)` and each row resolves the current tab object by id through a memo, so a metadata write patches the existing row instead of replacing it. The row receives the resolved accessor, and activation, closing, drag sorting and the context menu stay bound to the stable id rather than to a captured object.

## Alternatives considered

**Suppress tab metadata writes while a pointer is down.** Rejected because it makes titles and URLs lag behind page loading, and it only covers this one input path. Any other rekey — restore, dirty flag, resource replacement — would still drop presses.

**Debounce or batch metadata writes.** Rejected because it lowers the frequency of the race rather than removing it. The DOM identity still changes whenever the batch is applied.

**Replace the whole tab run on every change.** Rejected because it rebuilds unrelated rows, losing focus, hover and any in-progress drag, and makes misses more likely rather than less.

**Handle activation on `pointerdown` instead of `click`.** Rejected because it activates on a press the user may cancel by dragging the tab to reorder, and it breaks keyboard and accessibility semantics that the `tab` role depends on.

## Consequences

Tab rows keep their DOM node, focus and hit target across title, URL and dirty-state updates, so presses are no longer dropped. The row component now reads the tab through an accessor, so any future field it renders must stay reactive rather than destructuring the object. Drag ordering, middle-click close, keyboard traversal and the close hit area continue to key off the same id.
