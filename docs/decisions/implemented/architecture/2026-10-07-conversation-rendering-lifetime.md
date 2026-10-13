# Decision Record: Conversation rendering lifetime and retained recovery

Status: implemented

## Problem

Cold admission, navigation, recovery and virtualization share mutable presentation state without consistently sharing its owner. Recreating accepted bodies during reconnect loses visible content, and retaining layout through a service object fails when that service or virtualizer is replaced. Scope eviction can remove a store from the registry while a content-budget callback still retains it. These failures combine into unstable mounting, scrolling and memory growth.

## Decision

The native transcript owns a keyed Solid subtree identified by server URL, Scope and Session. Its virtual rows, execution reads, arrival receipts and admission latch share that lifetime. Composer and workbench owners remain outside the transcript. A captured first-send uses its preallocated Session identity, preserving the same transcript through canonical admission.

Recovery preserves accepted summaries, bodies and their byte accounting while marking loaded Part pages stale. Each accepted bounded Part interval is recorded independently. Revalidation reads only those intervals, preserves intervening live writes, removes authoritative missing Parts and publishes one coherent result. Accepted page readiness does not become a loading gap. Failed recovery retains readable content and the existing explicit retry surface. Request completion validates its captured Scope store, generation and cancellation lifetime before writing session metadata, diff or runtime projections.

Virtual layout uses an access-order cache limited to 128 entries and 4 MiB. Keys contain primitive transcript and presentation identities; values contain cloned row keys, numeric measurements and width. These measurements are layout hints; mounted content still measures its current geometry. Ref release captures the virtualizer before losing its handle. A different width, presentation or row sequence rejects restoration, and a width change during mounting invalidates that binding's later cache publication. Layout entries retain no service, store or DOM references.

Pure prepends shift measured virtualizer heights with an exact suffix of retained row identities. The viewport publishes the owner of its accepted reading anchor. The outer virtualizer maps that owner to at most one retained row, and the viewport alone restores its geometry. Native scrolling updates the owner throughout keyboard paging and inertia; following, rebinding and disposal release it. Resize delivery accepts the current offset after anchor restoration, including an already aligned position, so a virtualizer compensation receipt cannot recapture another visible row. A separate input classifier or one-scroll pending flag cannot keep this row identity current. The session page and outer list no longer schedule duplicate DOM anchor corrections.

Keyed retention also requires continuous DOM connection. The framework's generic array reconciler can temporarily replace a common node during an ordered virtual-window update, clearing native focus and selection before reinserting it. The pinned reconciliation correction admits ordered membership changes by deleting obsolete nodes and inserting new nodes around their retained neighbors. Common nodes do not move, chronological DOM order remains unchanged, and actual reordered sequences retain the original algorithm. This changes the owning DOM reconciler instead of adding focus restoration or another rendering owner; provenance and upgrade criteria live in [dependency patches](../../../../patches/README.md).

Process following remains explicit local state. A following active process follows late body measurements even without a new arrival receipt; upward reading, keyboard navigation and selection preserve the reader instead. Explicit movement owns its next native displacement and supersedes older layout restoration without a frame timeout. Direct inner virtualizer child churn is excluded from body-layout mutation classification while nested body growth stays protected. The idempotent input and mutation contract incorporates [the reviewed process reading change](https://github.com/SII-Holos/synergy/pull/1585), with additional ownership arbitration for simultaneous native movement and real body growth. Initial transcript admission fades once with the shared motion duration. Recovery and historical remounts do not replay arrival animation, and reduced motion settles immediately.

Scope eviction clears its exact content-budget prefix together with content caches and asynchronous owners. A full-GC browser regression checks reachability of released store payloads rather than treating RSS or a heap-size trend as proof of cleanup.

## Alternatives considered

**Clear and reconstruct on reconnect.** This loses accepted DOM and reading geometry before replacement data is available. Refetching the first Part page also replaces a previously loaded historical interval with unrelated content.

**Reset selected signals in a reused transcript.** This leaves virtual exit rows, disclosures, layout requests and execution state with overlapping lifetimes. One keyed transcript owner gives those resources a single disposal point.

**Cache layout by conversation service.** Service identity changes independently of the resource being displayed. It also encourages retaining closures that reference stores. Primitive identities and plain bounded measurements preserve restoration across owner replacement without retaining the old owner.

**Infer reading intent from scroll distance.** Virtualizer compensation and delayed layout produce scroll displacement without human input. Reading gestures and selection own following state; measurements only honor it.

## Consequences

The transcript has one admission and disposal lifecycle, reconnect does not create an intermediate empty presentation, and the same history window remains readable while being revalidated. Extra client page metadata records already accepted intervals without changing the server pagination protocol. Layout reuse is deliberately rejected when geometry or row identity differs. The cache has a fixed memory ceiling, and Scope cleanup has a deterministic reachability test. Existing large-history acceptance and synthetic heap evidence are recorded separately in the [rendering lifetime postmortem](../../../postmortem/0057-conversation-rendering-lifetime-and-scope-retention.md).
