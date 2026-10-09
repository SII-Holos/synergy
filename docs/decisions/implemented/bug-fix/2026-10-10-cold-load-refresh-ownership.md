# Decision Record: Cold-load refresh ownership

Status: implemented

## Problem

Execution-time reload planning and route-resolution loading must avoid duplicate cold-load requests without suppressing explicit transitions. A settled session can lose its workspace metadata or history refresh when the queued callback omits the transition trigger. A route effect that tracks reads inside the sync function also subscribes to the session collection, turning unrelated session insertions into permission refetches for the unchanged route.

This record supplements [cold-load fetch cascade deduplication](2026-10-09-cold-load-fetch-cascade-dedup.md) with callback input and reactive dependency ownership; its replay, freshness and content-cache decisions remain unchanged.

It also supplements the route-resolution loading in [visible-first session loading](../feature/2026-10-09-visible-first-session-loading.md), preserving the shared route/mount pipeline rather than adding a separate loader.

## Decision

[SyncProvider](../../../../apps/web/src/context/sync.tsx) forwards `options?.trigger` through the callback passed to `queueSessionSync`, just as the active-request transition branch does. The callback still computes its reload plan from the current store at execution time. A settled workspace transition refreshes authoritative session metadata without replacing the established message window; a history transition refreshes metadata and the message window.

[DirectoryLayout](../../../../apps/web/src/pages/directory-layout.tsx) declares `params.id` as the route effect's dependency with Solid `on`. The callback's sync reads are untracked. Route entry and session-ID changes start the existing sync pipeline; same-route collection updates do not start another permission or snapshot request. The page mount still joins the route load through the existing queue.

The message apply owner computes Part snapshot actions from the fetched timeline item and referenced-root IDs retained by the effective window. Timeline items carry message headers, not inline Parts; deriving repair identities from optional legacy Parts omits every real response. A generation change rejects the complete window. A message-only mark excludes that message's prefetched summary and bodies, admits unaffected headers and content, and registers targeted repair inside the apply batch before reactive consumers observe stale state. The visible consumer joins this pending owner rather than starting an ordinary refresh ahead of a queued forced refresh. Accepted pages remain stale until successful refresh, preserving their content and cursors while allowing the normal load/error/Retry path to recover transport failure. No background retry loop or new loader is introduced.

The [partial-apply suite](../../../../apps/web/test/context/sync-partial-apply.dom.test.ts) supplies typed generated timeline items without inline Parts. It verifies exact batch IDs and summary-version convergence for cold and warm pages, normal consumer retry after failed targeted reads, cancellation and no late publication after disposal, and whole-window rejection on generation drift. A retained history referenced root has a real accepted range and cursors; its mounted reactive consumer must join exactly one range refresh and expose explicit Retry after transport failure without losing accepted content. The same-version freshness control verifies that acceptance leaves its request revision unchanged; a newer server version advances it. Private acceptance helpers return the consumed boolean, without an unused refresh flag.

The existing mounted DOM suites own the regression evidence. [The join suite](../../../../apps/web/test/context/sync-join.dom.test.ts) mounts the actual DirectoryLayout and SyncProvider with reactive route parameters and SDK request fixtures. It checks single-flight timeline/Part loads, metadata refresh after a queued workspace transition, no extra requests after an unrelated session insertion, and normal loading after a route change. [The history suite](../../../../apps/web/test/context/sync-history-transition.dom.test.ts) checks workspace metadata and history-window updates after completed sync calls, retained-history reconnect recovery, queued navigation and disposal. Its fixture supplies the batch Part API as a message-ID-keyed map; no production fallback is added.

## Alternatives considered

**Keep the queued callback trigger-free.** This preserves the settled-window short circuit but drops an explicit transition's forced metadata or history refresh. Forwarding the trigger retains both current-state planning and transition intent.

**Wrap the route sync call in `untrack`.** This can isolate the same internal reads, but `on` declares the route dependency directly and keeps the guard and sync call in one callback. Neither approach needs a new loader or abstraction.

**Validate only the reload-plan helper.** Helper tests cannot detect a missing trigger at the provider call site or incidental reactive subscriptions in the mounted route owner. The existing DOM suites exercise those integration paths without adding a separate fixture or increasing timeouts.

**Derive repair identities from inline Part payloads.** The timeline endpoint does not carry them. Tests that attach synthetic Parts permit the repair path to run while production discards the marked viewport and repeats the entire timeline read. Fetched header identities, intersected with the effective retained window, match the public endpoint and avoid repairing dropped messages.

**Leave a failed forced warm refresh marked fresh.** The summary loader short-circuits ordinary loads for a fresh accepted page. Marking only affected pages stale preserves their accepted data while keeping the existing visible recovery owner effective; propagating the background failure into a complete window reload would undo partial apply.

**Register repair after publishing stale state.** Solid flushes mounted consumer effects as the apply batch ends. An ordinary refresh can then start before the forced repair, causing the loader to serialize two reads. Registering repair within the same batch establishes its pending owner before effects flush while retaining the existing loader's distinct forced-refresh semantics elsewhere.

## Consequences

Explicit transitions remain effective when no base request is in flight, while execution-time planning and satisfied joins continue to avoid duplicate cold-load message waves. Session collection writes remain reactive for consumers that read them, but they do not cause route-owned REST requests. Refreshes for workspace/history transitions and reconnect recovery remain owned by their existing sync paths rather than by incidental collection invalidation.

The regression suites retain their existing timeouts and strict read counts. Test-side injection of the old bare route effect makes the same-route insertion assertion fail with an extra permission read; the injection is removed from the final test. The tests cover real Solid provider/effect behavior with SDK fixtures, not a live backend or a production-browser performance benchmark.
