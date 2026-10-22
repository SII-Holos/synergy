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

Keep cancellation of pending inference separate from the lifetime of a completed suggestion. When the product retains suggestions, use one feature-owned saved record scoped to server, Scope and Session, restore it through the existing completion service, and distinguish explicit dismissal from renderer disposal. Verify navigation and reload without new inference, owner isolation, and non-resurrection after acceptance, dismissal, editing or new work.

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

Bind retained trees to immutable server/Scope/Session/plugin owners; audit descendant router reads, callbacks, async responses and native presentation when adding residency. Keep one active composer. Test A→B→A across Scopes with real DOM identity, reading/selection/draft continuity and bounded inactive work. Registry module promises and presentation instances have separate lifetimes. Eviction must preserve domain-owned drafts and native resources. Exercise portalled decisions, menus and dialogs while switching by keyboard or router action, not only outside clicks. Verify that inactive callbacks cannot reopen overlays, pending decisions survive return, focus stays with the new owner, and document-level shortcuts neither act on hidden panels nor consume another editor's input. Reuse the shared `ViewActivityProvider` rather than deriving activity from DOM visibility.

For projected transport changes, exercise real WebSocket clients and replay with intentional omissions, genuine gaps, old subscription generations, oversized content and disconnect cleanup. Do not equate replay success with complete tool bodies: validate retained page generations after recovery. Keep performance fixtures semantic by creating user messages through `MessageV2.deriveSemantics()` with actual user Parts. Validate fixture visibility before recording timing. Compare identical workloads sequentially against production builds and retain invalid/failed samples separately from accepted measurements.

For retained-view catch-up, measure HTTP bodies separately from event traffic and cache/prefetch budgets. Hold body responses while leaving the viewport and confirm cancellation reaches the generated SDK; queued obsolete reads must never dispatch and a shared active reader must survive another reader's release. Measure browser long tasks and mounted DOM separately from compressed transfer bytes; huge live snapshots must remain virtualized and converge while inference stays open. Test crossing from a short rendered prefix into a long snapshot: preserve the reading point and keep the unseen tail reachable without treating it as measured. Verify nested reading owners transfer accepted geometry instead of restoring detached DOM fallbacks over a completed inner restoration. Exercise punctuation-heavy streaming catch-up with preserved DOM/source positions, using mutation counts instead of CI latency thresholds. Async selection actions must retain their captured selection identity so a late clipboard or plugin completion cannot close a newer menu.
