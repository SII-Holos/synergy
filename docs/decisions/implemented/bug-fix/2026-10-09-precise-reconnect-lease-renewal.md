# Decision Record: Precise reconnect lease renewal

Status: implemented

## Problem

A content version identifies bytes, not whether a mounted row still owns the materializer entry that publishes those bytes. Invalidation removes the entry and evicts accepted content from the display projection; revalidation resets its read promise while retaining accepted content. Reusing a same-version lease without checking ownership can therefore leave an invalidated body absent or a row waiting on a retired read. Disposing every lease after summary refresh repairs the missing projection but unnecessarily retires healthy pending reads and accepted leases.

## Decision

This decision supersedes [reconnect lease renewal after display projection loss](../../archived/bug-fix/2026-10-09-reconnect-lease-renewal-after-projection-loss.md). The archived record preserves the original full-disposal choice and its rejected liveness probe; neither governs current renewal. The complementary [canceled-fetch-storm decision](2026-10-08-part-content-canceled-fetch-storm.md) owns the global version-cache rationale and transport deduplication decision.

After a stale summary-page reload succeeds, the row releases only leases whose part state is failed, then increments its retry signal. The retain effect reuses a same-version lease only when its optional `isCurrent()` probe does not return false. Native materializer leases report current ownership only while unreleased, the materializer is undisposed, the entry map still contains the exact retained entry, and the entry's `ready` promise is the exact promise captured at retain time. Entry identity detects invalidation even after the old promise resolved; captured-ready identity detects revalidation even when the entry and content version remain unchanged.

When renewal is necessary, the row acquires the successor lease and records it before releasing the predecessor. This avoids a zero-consumer interval that would abort a successor read sharing the existing entry. Completion handlers update row state only if the row still owns that exact lease. Healthy pending same-version reads and current accepted leases remain retained across summary refresh. The public conversation lease probe is optional for existing providers; the native materializer and capability/lifetime adapter expose it.

Row consumption, shared materializer lifetime, and transport lifetime remain distinct. Global sync owns `PartContentStore`, which shares pending transports and completed serialized snapshots by `url/scopeKey/partID/version`. SyncProvider content reads register cache consumers with the reference-counted materializer lifetime signal, not the row lease signal or the first page's lifetime. A row release or invalidation stops materializer consumption and fences obsolete publication without cancelling the cache consumer. Releasing one page preserves a materializer retained by another page; the final page release aborts its lifetime signal and disposes that materializer. The final departing cache consumer cancels the shared transport. Matching-promise cleanup prevents an obsolete completion from deleting a retry, and transport abort checks fence late responses from caching. Completed snapshots remain in the bounded global cache independently of materializer disposal; callers receive detached Part objects.

## Alternatives considered

**Release every lease after summary refresh.** This is the original choice preserved in the archived record. It rebuilds missing projections but discards healthy consumption ownership unnecessarily. Transport deduplication does not make blanket materializer disposal necessary or preserve the row's original pending lease.

**Keep failed-only cleanup and reuse leases by version alone.** Equal versions establish equal content, not entry ownership or read identity. This misses both an evicted projection and a revalidated same-version read. Promise completion alone also cannot establish current ownership.

**Bind content transport to a row or the first page.** Row departure would discard an in-flight shared read; first-page departure would cancel work still owned by another page. The reference-counted materializer signal and global cache consumer count preserve live peers while permitting cancellation after the final owner departs.

## Consequences

Precise renewal restores invalidated bodies without treating every successful summary refresh as a reason to restart healthy pending work. The ownership probe adds an explicit check, but distinguishes byte identity, entry identity, and read identity without a blanket cleanup rule. Existing providers without the optional probe keep their same-version reuse behavior; only providers exposing it can report detached ownership through this interface.

Verification covers separate ownership layers: materializer tests exercise invalidation before and after completion, captured-ready changes during revalidation, same-version successors, and late-publication fencing; conversation DOM tests require invalidated bodies to return and healthy pending reads to survive summary refresh. Global sync lifecycle and content-store tests cover overlapping page owners, shared transport consumers, final-owner cancellation, retries, detached snapshots, and bounded cache accounting. These are implementation and test-source references, not a claim that those suites ran during this documentation correction.

Implementation evidence: [row renewal](../../../../apps/web/src/components/session/virtual-conversation-rows.tsx), [materializer ownership](../../../../apps/web/src/context/part-materializer.ts), [global sync ownership](../../../../apps/web/src/context/global-sync.tsx), [SyncProvider cache reads](../../../../apps/web/src/context/sync.tsx), [global content store](../../../../apps/web/src/context/part-content-store.ts), [public lease interface](../../../../packages/plugin/src/conversation.ts), and [conversation adapter](../../../../apps/web/src/plugin/surface-conversation.ts).
