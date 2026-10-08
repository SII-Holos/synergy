# Decision Record: Part content canceled-fetch storm on session navigation

Status: implemented

## Problem

Switching back to a previously viewed session re-fetched every rendered Part's content (the summary `version` identical), and the DevTools network panel showed a storm of `(canceled)` GETs followed by identical re-sends with the very same version parameter. On an HTTP/1.1-only deployment behind a reverse proxy, this translated to 1–2 seconds of perceptible delay on every session switch even after the batched part-summary fan-in ([batched part summary pages](../feature/2026-10-08-batched-part-summary-pages.md)) had removed the summary-page stall. HAR captures confirmed the content never changed across switches (identical `version` across up to six requests for the same part).

## Decision

Three independent causes, fixed at three layers:

- **Stale-load scorched-earth cleanup** (`virtual-conversation-rows.tsx`): a stale summary page finishing its reload used to release **all** retained part leases unconditionally, which aborted every in-flight content read for that message and reissued identical requests. The retain effect was already version-aware; only genuinely failed parts needed recycling. The completion handler now releases only leases whose part state is `failed`.

- **No durable content cache anywhere**: content materializer entries lived inside a provider-scoped, reference-counted store that `dispose()`d wholesale on unmount, and the shared `contentBudget` LRU republished `bytes * 2` per summary update so previously read parts silently fell out of memory. Part content is content-addressed (summary `version` is a content hash), so a new global `PartContentStore` (`part-content-store.ts`, 64 MB budget, keyed by `url/scopeKey/partID/version`) now remembers finished reads; session switches, LRU pressure, and materializer restarts can no longer force a same-version refetch. The version check keeps the hash guarantee honest — a real edit arrives with a different version and simply misses.

- **In-flight reads discarded with the row**: the remaining canceled requests came from rows scrolling out of view mid-flight (leases released → in-flight read aborted with nothing cached yet). The materializer's transport layer now binds a fetch to the provider lifetime (`contentLifetime.signal`) rather than the lease's `AbortSignal`; a released lease stops the consumption loop, but the fetch completes and its result lands in the `PartContentStore`, so the next retain for the same version is a cache hit with zero requests.

## Alternatives considered

- **Abort-based lifecycle with request dedupe**. Deduplicating identical concurrent fetches would shrink the visible storm but would still throw away a nearly finished read on every navigation; it cannot remove the resends.
- **Cache at the materializer store layer instead of a separate store**. The materializer's map is reference-counted and disposed by design; adding a second on-dispose-frozen map inside it would have duplicated lifecycle machinery and masked its existing abort contract, which the harness encourages tests to keep explicit.
- **Keep per-fetch aborts, rely on HTTP cache**. The API has no cache validators and the deployment does not build one; delegating durability to a CDN would also violate the "version IS the key" property only a client-side store can exploit.

## Consequences

- Navigating back to a static session now issues zero content requests when every summary version match the store's memory; HAR deltas go from ~42 entries per switch (with 8+ cancels and several resends of identical versioned GET) to ~18 (timeline page only, plus one-time fetches for new parts), and canceled content requests disappear from the captured flow entirely.
- The new `PartContentStore` is bounded (64 MB LRU) and holds _immutable_ bytes — a version is never re-keyed or edited in place — so it cannot serve stale content and is safe to keep across an entire app lifetime.
- Row-level release no longer aborts transports, which keeps the materializer's abort contract semantics for `invalidate`/`dispose` (cancel and drop) untouched: those paths still kill in-flight reads and evict entries, matching the pre-existing harness contract tests.
- The remaining switch latency is limited to the single `timeline/page` request and any new-part reads, both of which are real work rather than repeated work.
