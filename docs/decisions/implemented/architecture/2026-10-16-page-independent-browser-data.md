# Decision Record: Page-independent Browser data management

Status: implemented

## Problem

Browser password management and import depended on a real page handle even though listing password metadata and importing into a persistent identity require no website content. Opening a hidden or blank page for Settings would allocate unrelated browsing state and couple management authority to a selected tab.

## Decision

Use the existing authenticated backend-to-Desktop broker to prepare ephemeral profile data contexts. The backend resolves the enabled persistent profile and its revision; Desktop privately maps the opaque context to the authoritative partition and broker epoch. Public API results contain only the opaque ID and public profile metadata. Renderer requests never supply a partition.

Protocol v7 adds the strict preparation, release and management messages. A profile context admits state, source discovery, import, progress, cancellation and password deletion, but cannot save or fill a webpage form. Existing page targets retain exact-origin save/fill and never submit. Both targets reuse BrowserDataStore and the same import implementation; no second credential store, parser or job table is added.

Profile lifecycle and management share invalidation and serialization. Contexts are revoked on disposal, broker or Runtime changes and profile revisions; an asynchronous OS result rechecks its captured destination before writing. Native close and backend release are independent cleanup attempts; release requires a fresh owner-bound presentation ticket because creation consumed the previous one. Jobs capture their original target, cancellation retains completed records, and ownership checks prevent a stale context from controlling another job. Password and Cookie values remain within Desktop and encrypted storage; renderer results carry metadata and counts only.

Global Settings exposes one lazy Browser page with Import browser data and Manage saved passwords. It is visible only after the selected module and matching managed-local native data bridge are confirmed. Child dialog code loads before pushing its modal root: an initially empty portal can otherwise be hidden by the enclosing Settings dialog before lazy content arrives. The default persistent profile is captured when a child dialog opens; multiple eligible profiles permit an explicit dialog-local choice. Immediate data operations do not enter or reset unrelated Settings drafts. Advanced identity and website controls remain in Browser options.

The page owns the exact management dialog ID, and each confirmation owner tracks its own confirmation IDs. Removing an owner closes those dialogs rather than popping the top of the shared stack; pending confirmation promises resolve as cancellation. Module removal and connection replacement therefore dispose nested confirmations, contexts and import work while preserving unrelated dialogs and Settings drafts.

## Alternatives considered

**Create an invisible about:blank page for management.** Rejected because management must work with zero pages and must not change Workspace tabs, selection or website state.

**Let the renderer name the partition.** Rejected because a presentation surface cannot authorize access to arbitrary local browser identities.

**Build a separate global account store.** Rejected because import, encryption, deduplication and deletion already belong to the native Browser data owner.

**Add a broad browser-preferences collection.** Rejected because this change has only two management intents. Default internal opening is a product policy; external opening remains an explicit resource action rather than another global preference.

**Keep a silent older-protocol page fallback.** Rejected because the new authority model is a real wire change. Mixed versions must fail explicitly instead of allocating an unexpected page.

## Consequences

Global management works independently of browsing and task creation. The new contexts are ephemeral and require no persisted schema migration; the existing profile catalog, partition identities and encrypted store remain authoritative. Desktop and backend must agree on Protocol v7, while BrowserNativeLease retains its separate signing-claims version. Native platform and OS authorization failures remain local operations with explicit recovery.

Ownership is defined in [Browser runtime](../../../architecture/browser-runtime.md#browser-product-data-and-results), and the human-facing entry is documented in [Browser workspace](../../../product/browser.md#local-browser-data).
