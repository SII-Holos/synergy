---
name: develop-frontend
description: Implement or review Synergy Web and shared UI changes across apps/web and packages/ui. Use for components, contexts/stores, navigation, settings, dialogs, workbench surfaces, semantic icons, themes, responsive behavior, accessibility, frontend API calls, event sync, and product interaction changes.
---

# Develop the Frontend

Preserve domain state and generated API ownership, public theme tokens, localization, real provider lifetimes and the current product contract. Use the verification table before choosing expensive checks. Read only references for the affected domain.

## Read the Contracts

1. Read `apps/web/AGENTS.md` and [Web product contract](../../../apps/web/PRODUCT.md).
2. Read [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) for contexts, snapshots, events, streaming, composer intent, or loaded buckets.
3. Read [Browser runtime](../../../docs/architecture/browser-runtime.md) for Browser UI or Desktop/Web presentation changes.
4. Load `change-server-api` when the UI needs a new or changed server contract; load `add-tool` for tool-card presentation.

Composer assistance uses the shared document completion and generic input-assistance metadata. Preserve provenance through edits, draft transfer, failed-submit restoration and ordinary message submission. Test late completion events against synchronized history, source edits and same-URL reconnects; completion status and historical rendering alone must never initiate automatic inference.

Keep cancellation of pending inference separate from the lifetime of a completed suggestion. When the product retains suggestions, use one feature-owned saved record scoped to server, Scope and Session, restore it through the existing completion service, and distinguish explicit dismissal from renderer disposal. Draft editing, completion acceptance, IME and temporary blockers hide the saved suggestion until the draft is eligible again. Verify restoration without inference after clearing an unsent or failed draft, navigation and reload, owner isolation, and non-resurrection after explicit dismissal or confirmed new input. Optimistic message display and busy status alone are not submission confirmation; use canonical messages and accepted Inbox state.

When a background producer shares a saved record with a mounted consumer, test remount before as well as after its response. Same-window storage writes do not update another persisted store automatically. Keep completion claims owner-scoped and bounded, and verify cancellation on configuration, capability and connection changes without erasing completed results.

Manual composer assistance returns focus at invocation, before disabling its trigger. Do not steal focus on asynchronous completion. Verify the real button-to-editor path, including moving to another control before the response arrives.

Keep staged workflow choices visibly separate from bound execution status. Exercise native drop through the real Composer controller, verify cancellation versus draft removal, and assert no start or metadata request before submission. Optional plugin icons must tolerate absent values throughout reactive updates.

Global events must not hydrate unviewed Scopes merely to update sidebar status, Cortex or pending requests. Test cold metadata delivery and genuine sequence-gap/reset recovery together; preserving one must not suppress the other.

## Verify

Start with `bun run verify plan`. During iteration run the narrow component, model or context test; before publication use `bun run verify local --test apps/web/test/<domain>/<file>.test.ts` with all relevant tests explicitly selected. The entry point uses canonical coverage executors and static gates; it leaves complete package thresholds and platform acceptance to CI.

| Change                                                      | Additional local evidence                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New source or test fixture                                  | Fresh focused LCOV includes each new measurable source; read [browser fixtures](references/browser-fixtures.md) for real layout, virtualization and provider ownership.               |
| Coverage policy, instrumentation, removed coverage          | `bun run verify coverage --package apps/web` (or the actual owner).                                                                                                                   |
| Bootstrap, browser capabilities, bundler or package exports | Web production build, browser crypto contract and private HTTP smoke; `verify local` runs these for its known entry paths. Inspect the plan for other affected boundaries.            |
| Copy, translations or locale formatting                     | Extract catalogs and run `localization:check`; verify cold start, switching, errors and lazy catalogs as described in [presentation](references/presentation.md#localize-product-ui). |
| Visible interaction or layout                               | Inspect changed states, themes, focus and narrow geometry in one isolated runtime.                                                                                                    |
| Native Browser, window chrome, protocol or Electron         | Exercise the actual Desktop boundary using its owning skill.                                                                                                                          |

Run static gates after browser tests and builds finish; they mutate shared generated artifacts. Do not run both whole Web/UI suites on every edit. Broaden only for unresolved failures or affected shared behavior. Load the relevant domain reference below before changing its contract.

## Message process and execution details

Read [the domain guidance](references/conversation.md#message-process-and-execution-details) when this area is affected.

For request-context views, share one estimate/actual display projection across charts and source browsing. Keep actual-only API fields intact. Follow the last displayable request with its original identity until the next is ready; reset retention on Scope, Session or round changes and preserve explicit historical selection. Test both arrival orders, stale history responses, category-node identity and source-body fetch counts. Update values without adding lifecycle status text or remounting disclosures.

## Settings recovery

Directory recovery must complete the captured task selection after confirmation, preserve its draft and clear obsolete retry actions without sending automatically. Test a completed rebind followed immediately by send, a stale implicit main-folder snapshot, background changes to an explicit selection, cancellation and late completion after changing owners.

Read [the domain guidance](references/state-and-recovery.md#settings-recovery) when this area is affected.

## Library and statistics recovery

Read [the domain guidance](references/state-and-recovery.md#library-and-statistics-recovery) when this area is affected.

## Preserve State and API Ownership

Read [the domain guidance](references/state-and-recovery.md#preserve-state-and-api-ownership) when this area is affected.

## Preserve Browser Capability Boundaries

1. Route ordinary App/UI identifiers through `generateUUID()` or `generateRandomBytes()` from the shared utility package. Do not call `crypto.randomUUID()` or `crypto.getRandomValues()` directly from browser source.
2. Use `generateSecureUUID()` or `generateSecureRandomBytes()` for authentication state, nonces, credentials, and other security-sensitive values. A missing secure source must fail only the affected operation; it must never fall back to `Math.random()`.
3. Keep optional browser APIs out of module-scope startup paths. Gate Clipboard, Notifications, credentials, media, and other Secure Context capabilities at the owning action and provide a local unavailable or error state.
4. Treat non-loopback private-network HTTP as a supported Web deployment. When capability or bootstrap code changes, verify an actual non-Secure Context rather than relying on localhost.

Keep organization authorization and callback pages independent of personal Runtime readiness and subscriptions. Exercise the real organization service across separate HTTPS origins: first-party login, exact-window callback, cookie-based recovery after reload, explicit logout, isolated opener and late cancellation. Use strict randomness for state/verifier and clear callback fragments before rendering. Do not infer popup compatibility from CORS headers; test the served opener policy in Chromium. Authentication state machines remain directly measured while rendered pages use the owning browser fixture.

For organization decisions, test finite pending pages separately from explicit native winner queries and the client's own logical receipt. Do not use a partial page to clear unseen drafts or infer successful submission. Password input steps and original sensitive command payloads remain volatile: exercise storage inspection and reload recovery without reconstructing an answer under an old logical ID. See the [decision recovery record](../../../docs/decisions/implemented/architecture/2026-11-11-reconcile-organization-decisions-with-native-winners.md).

Task navigation must distinguish the selected reading source from root commands and resources. Exercise different root/child Run IDs and control versions, retained main drafts, child interaction queries, shared metadata-only pages and the captured supervised-member reader. Verify a narrow child view without adding clipped controls. See [organization task reading](../../../docs/decisions/implemented/architecture/2026-11-12-keep-organization-task-reading-separate-from-root-controls.md).

Exercise the real IndexedDB owner when changing decision recovery. Page headers without reading payloads, verify unresolved histories beyond the displayed residency budget, and keep exact native identities blocked outside the current page. Capture a question's step policy before asynchronous page changes; test disposal and a second live owner as well as reload.

Question draft persistence stays behind the shared editor's port. Verify selected-question hydration, stale replies, write coalescing, a failed replacement racing native resolution and disposal while deletion is pending. Upgrade known project records through the owning transaction and completion receipt; exercise actual old Scope keys, account/source boundaries, rollback, restart and failed old-key cleanup. One-time migration parsing does not establish steady-state body residency. Queue labels must not open cold answers. See [point draft ownership](../../../docs/decisions/implemented/architecture/2026-11-12-hydrate-organization-question-drafts-by-identity.md).

## Localize Product UI

Read [the domain guidance](references/presentation.md#localize-product-ui) when this area is affected.

## Use Semantic Icons

Read [the domain guidance](references/presentation.md#use-semantic-icons) when this area is affected.

## Preserve Product Presentation

Read [the domain guidance](references/presentation.md#preserve-product-presentation) when this area is affected.

## Execution details

Read [the domain guidance](references/conversation.md#execution-details) when this area is affected.

## Preserve Loading Boundaries

Read [the domain guidance](references/state-and-recovery.md#preserve-loading-boundaries) when this area is affected.

## Change Themes and Color Tokens

Read [the domain guidance](references/presentation.md#change-themes-and-color-tokens) when this area is affected.

## Handoff

Report changed behavior, ownership, focused tests, visual evidence and pending CI or platform checks. Distinguish local verification from merge readiness.

## Replaceable plugin presentation

Read [the domain guidance](references/workbench-acceptance.md#replaceable-plugin-presentation) when this area is affected.

## Complete workbench acceptance

Read [the domain guidance](references/workbench-acceptance.md#complete-workbench-acceptance) when this area is affected.

## Large-history verification

Read [the domain guidance](references/workbench-acceptance.md#large-history-verification) when this area is affected.

## Resource Workspace changes

Read [the domain guidance](references/resources.md#resource-workspace-changes) when this area is affected.

## Conversation navigation motion

Read [the domain guidance](references/conversation.md#conversation-navigation-motion) when this area is affected.

## Conversation process and read-only evidence

Read [the domain guidance](references/conversation.md#conversation-process-and-read-only-evidence) when this area is affected.

## Verify File Review and Restoration

Read [the domain guidance](references/resources.md#verify-file-review-and-restoration) when this area is affected.

## Retained view changes

Read [Memory residency scope](../../../docs/operations/memory-residency-scope.md) for the retain, boundary, and hot globs and the admission lint.

Bind retained trees to immutable server/Scope/Session/plugin owners; audit descendant router reads, callbacks, async responses and native presentation when adding residency. Keep one active composer. Test A→B→A across Scopes with real DOM identity, reading/selection/draft continuity and bounded inactive work. Registry module promises and presentation instances have separate lifetimes. Eviction must preserve domain-owned drafts and native resources. Exercise portalled decisions, menus and dialogs while switching by keyboard or router action, not only outside clicks. Verify that inactive callbacks cannot reopen overlays, pending decisions survive return, focus stays with the new owner, and document-level shortcuts neither act on hidden panels nor consume another editor's input. Reuse the shared `ViewActivityProvider` rather than deriving activity from DOM visibility.

Byte-backed previews need a shared active owner and an explicit body budget; a per-file limit alone permits every visible card to retain another buffer. Verify preview replacement and release on version/source changes or lost authorization. Keep complete downloads on a backpressured save stream, and show an unsupported-capability message when that sink is absent instead of retaining a whole-file Blob.

File disclosures use safe summary counts before body preparation. Measure metadata and byte requests separately from ordinary tool headers. Exercise empty visible pages with continuation, ordinal zero, a late file, page replacement, collapse cancellation and lost authorization; no file operation may infer authority from a display count or a different producer version.

For projected transport changes, exercise real WebSocket clients and replay with intentional omissions, genuine gaps, old subscription generations, oversized content and disconnect cleanup. Do not equate replay success with complete tool bodies: validate retained page generations after recovery. Keep performance fixtures semantic by creating user messages through `MessageV2.deriveSemantics()` with actual user Parts. Validate fixture visibility before recording timing. Compare identical workloads sequentially against production builds and retain invalid/failed samples separately from accepted measurements.

For demand tiers, trace each consumer through interest merging, capability negotiation, projection opening and the owning shared read. Test downgrade after the last expensive reader leaves while a cheaper reader remains, shared cancellation, progress without metadata revision changes, and immutable checkpoints of every state. A partial projection must never enter a complete-summary event or overwrite accepted statistics. Preserve legacy consumers on a capable server as well as new consumers on an older server.

For retained-view catch-up, measure HTTP bodies separately from event traffic and cache/prefetch budgets. Hold body responses while leaving the viewport and confirm cancellation reaches the generated SDK; queued obsolete reads must never dispatch and a shared active reader must survive another reader's release. Measure browser long tasks and mounted DOM separately from compressed transfer bytes; huge live snapshots must remain virtualized and converge while inference stays open. Test crossing from a short rendered prefix into a long snapshot: preserve the reading point and keep the unseen tail reachable without treating it as measured. Verify nested reading owners transfer accepted geometry instead of restoring detached DOM fallbacks over a completed inner restoration. Exercise punctuation-heavy streaming catch-up with preserved DOM/source positions, using mutation counts instead of CI latency thresholds. Async selection actions must retain their captured selection identity so a late clipboard or plugin completion cannot close a newer menu.

For live file-change presentation, verify complete totals beyond the message projection, baseline cancellation, continuation, failed refresh and final publication, stable Review revisions, cold root discovery, reconnect and removal races. Measure dirty capture and comparison together on a large real source corpus, both before and after thousands of files have accumulated net changes; count bytes read and native commands separately from latency. Cover file/directory replacement and omission recovery when incremental results inherit prior statistics. Exercise wide and 375 px activity wrapping, expanded Composer, keyboard activation and mobile Review without the root loaded in the transcript. Include intermediate conversation widths within a wide viewport: compact controls that fit together must share a row above longer wrapped summaries, with keyboard order matching visual order. Check large Review mount and disposal, bounded row/body work, keyboard navigation beyond the mounted range and retained focus or selection. Refresh metadata without remounting file disclosures, reopen after an earlier variable-height row, verify comparison-scoped reading anchors, and cancel offscreen reads without aborting other readers of the same file; summary timing alone cannot establish detail-view responsiveness. Hold lazy mobile content under the real page Suspense owner and verify that loading leaves the original conversation and modal entry mounted.

For experimental product UI, load [develop-feature](../develop-feature/SKILL.md). Use the feature catalog for experimental settings and effective capabilities for ordinary entrypoints. Verify disabled deep links, restored panels and reconnect responses.

Browser cost and flaky fixture repairs follow [the stability workflow](../testing-guide/references/stability.md). Reuse compiled fixtures with fresh pages; measure cold and warm preparation before extending a DOM matrix.

For destructive account actions, test reload before the native request arrives as well as after pending and final receipts. Keep credential-free recovery metadata in its existing connection owner, outside controlled-cache deletion. Use transactional point ownership across windows, preserve the original revision/request, and reject an older action after refresh or later login. Distinguish confirmed access loss, which clears private views, from temporary transport failure, which retains drafts.

Hold an accepted save across Cancel, reopen the editor and deliver the old response; the replacement draft must survive without another write. Component disposal must retire callbacks independently of the selected Space. On confirmed authority loss, clear private catalogs and descendants and invalidate prior request generations; after explicit recovery, old reads and one-time links must remain retired. Keep separate 503 cases proving drafts survive, and test nested metadata errors reaching the owning catalog. Hold a catalog response while opening its confirmation, then deny access; close exact owned dialog IDs and capture the original generation and target at show time. Verify another owner’s dialog survives, recovery needs a new confirmation, and late accepted completion cannot trigger retired UI callbacks or errors.

Exercise selector A→B→A with both a held read and accepted mutation; equality with the current selector does not establish request identity. Capture the full Space and project or resource identity before awaiting, including when a component receives reactive props without disposal. Close and reopen discovery while its first search waits, and refresh metadata behind a confirmation to verify that its original revision remains fixed. Opening or cancelling a publication can restore focus synchronously in the user's action; completion must not steal it from another control.

For background notification integration, switch the real App to another Space before delivering the source event. Verify the canonical Toast region survives, expand its normal actions before clicking, and keep target identity separate from the currently selected view. Hold browser permission and target-header reads across source replacement; neither display nor activation may revive the predecessor. Check personal socket identity and empty body interests across Space switches, and pair bridge-fixture browser evidence with actual native producer, authenticated service stream and Web adapter evidence.

Check publication actions against the owning write permission rather than a nearby management flag. Exercise organization and project scope separately, including execution-only collaborators, readers and archived projects. Refresh catalog metadata behind a withdrawal confirmation and verify its original revision remains fixed. Test denied management deep links directly; hiding the navigation item must not leave an empty pane or fetch a private catalog.
