# Architecture design docs

Durable design records for the session/message core and the frontend data-sync
layer. These describe the intended model — read the relevant one before changing
message assembly, the loop, inbox, undo/rewind, or frontend data loading — and
are kept in sync with the implementation (trust the code; update the doc when
they diverge).

## Documents

- [`session-message-core.md`](./session-message-core.md) — backend session/message semantics: the orthogonal `rootID`/`isRoot`/`visible`/`includeInContext`/`origin` fields, the serial-task loop, the O(1) compaction anchor, and the single-axis inbox `mode`. Detailed sub-docs live in [`session-message-core/`](./session-message-core/README.md) (message assembly · frontend message sync · undo/rewind). Issue: [#281](https://github.com/SII-Holos/synergy/issues/281).
- [`frontend-data-sync.md`](./frontend-data-sync.md) — frontend data loading and event handling: reconcile-based store writes, the `seq`/`epoch` sequence protocol with journal + replay, snapshot watermark headers, composer intent layering, streaming part write-behind, and bucket eviction. Issues: [#318](https://github.com/SII-Holos/synergy/issues/318), [#319](https://github.com/SII-Holos/synergy/issues/319).
- [`runtime-performance.md`](./runtime-performance.md) — runtime resource-cost redesign: delta-frame + checkpoint streaming wire protocol, a single-writer session runtime message cache built on #281's single-active-loop invariant, idle reaping for LSP / scope runtimes / browser sessions, and observability hot-path cost reduction.

## Related agent guidance

`AGENTS.md` (root), `packages/synergy/AGENTS.md`, and `packages/app/AGENTS.md` reference these documents and summarize the invariants agents must preserve.
