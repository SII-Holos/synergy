# Decision Record: Reconnect lease renewal after display projection loss

Status: implemented

## Problem

After the display projection invalidation path (stale part summary page → page reload via the stale-load effect), parts that had previously completed an error recovery (a 409 `SessionDisplayConflict` then a `refresh`-driven version bump) **disappeared permanently from the conversation** until the row remounted. The regression shipped with the canceled-fetch-storm fix (see [part content canceled-fetch storm](2026-10-08-part-content-canceled-fetch-storm.md)), which changed the stale-page completion handler in `virtual-conversation-rows.tsx` to release only leases whose part state carried `failed`, keeping all other leases in place.

That change was premature: `part-materializer.invalidate(messageID)` not only aborts in-flight reads, it also calls `input.evict(entry.accepted)` for already-applied entries — which **removes the displayed content from the session store** (`data.part`). The row retain effect (the only code that can rebuild the projection for a mounted row) short-circuits any part whose retained lease's summary version matches `summaries()[id].content.version` — and because content versions are content-addressed (`sha256(JSON.stringify(part))` in `packages/harness/src/session/message-v2.ts`), an unmodified part whose projection was just evicted still carries the same version. The new selective-release logic kept exactly these leases alive, so the retain effect never re-ran for them and the evicted content was never rebuilt. An A/B baseline (reverting only the row change, probes in `apps/web/test/fixtures/conversation/process.tsx`) confirmed: pre-PR behavior re-issued `retain progress v=…-next` after `invalidate` and recovered the content; post-PR behavior silently dropped it. CI (`conversation-process.dom.test.ts`, linux-2 shard) caught it.

## Decision

Restore full lease disposal when a stale summary-page reload completes (`virtual-conversation-rows.tsx` stale-load `.then` path): release **every** lease in the row's `retainedParts` map and clear it, then bump `retry` so the retain effect re-runs for all parts.

This is safe now for the reason the original blanket-release was removed: the content read's transport signal was moved off the lease (`sync.tsx` binds `partContent` to the provider-scope `contentLifetime`, and a version-keyed `partContentStore` absorbs duplicates). Releasing a lease therefore no longer aborts a healthy in-flight HTTP read — it only clears the materializer's ownership record so the retain effect can re-establish the projection. The blanket eviction path is correct **because** the transport and cache are lease-independent; the selective variant was correct only on the shallow invariant "same version ⇒ same bytes", which ignore the separate projection-loss dimension.

## Alternatives considered

- **Keep selective release and add a lease-liveness accessor on the materializer:** more moving parts for an edge case that generalizes to "any future projection-loss trigger must also reach each row" — the aggressive lease-clear is both simpler and covers all future callers of the stale-load path.
- **Fix it inside `part-materializer.invalidate` by recording "projection lost" per entry:** feasible but pushes a UI-projection concern into the cache layer; the row already owns how it rebuilds, and the projection store (`data.part`) is the row's reader, not the materializer's reader.
- **Adapt the assertions instead ("reconnect may not refetch"):** rejected — it masks a genuine user-visible disappearance (content gone until remount) behind a counting-semantics change, and the two failing tests were written precisely to pin this behavior.

## Consequences

- `conversation-process.dom.test.ts` tests `reconnect renews invalidated body leases even when the summary version stays the same` and `reconnect before the first summary page finishes restores invalidated bodies` pass unchanged in CI (verified locally: both green after the fix with the fixture unmodified).
- No re-appearance of the canceled-fetch storm: the storm's root cause (lease-scoped transport aborts on release) is what the transport rebinding fixed, and it is unchanged by this record. Verified locally via `sync-part-recovery.dom.test.ts`, `part-materializer.test.ts`, `part-summary-loader.test.ts`, `part-page-batch.test.ts`, `session-viewport-content.test.ts` (38+1 tests green) and the conversation recovery DOM suites (4/4 green).
- A brief note now marks the stale-page completion block as the projection-rebuild trigger, so a future optimization that re-attempts selective lease recycling must first verify the "projection loss despite same version" path.
- The relevant test contracts were not edited — the fix is production-side; the fixture probes used for diagnosis were local-only and are not part of this change.
