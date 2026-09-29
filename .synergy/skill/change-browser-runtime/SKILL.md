---
name: change-browser-runtime
description: Implement or review Desktop Browser pages, persistent identities, authorization, native popup/recovery lifecycle, commands/events, migration, files, and shared renderer controls across browser-core, browser-runtime, Desktop and Web.
---

# Change the Browser Runtime

## Trace ownership

1. Start at [Browser runtime](../../../docs/architecture/browser-runtime.md), then read the nearest package AGENTS.md. Read [Browser workspace](../../../docs/product/browser.md) and [Web product contract](../../../apps/web/PRODUCT.md) for interaction changes.
2. Trace the affected path through strict core schemas, backend catalog/command service, Desktop broker/page pool, generated SDK and shared renderer. The Desktop component owns availability; a shared frontend directory does not imply Web product support.
3. Load `change-server-api`, `change-persistence`, `change-execution-boundaries`, or `develop-frontend` when their ownership is crossed. Inspect the adjacent owner before adding an adapter.

## Preserve page and identity semantics

1. Keep real native pages with explicit page IDs. State reads allocate nothing. Opening, selecting, observing, resuming and closing are different operations; no command may infer an Agent target from the human's selected tab.
2. Reserve capacity before asynchronous creation. Keep command queues page-scoped and owner disposal ordered after Workspace leases. Allow a dialog reply to unblock its pending page command without changing its binding.
3. Adopt the Electron-supplied popup WebContents via the window-open options. Test opener, POST, postMessage, self-close and opener-close independence; loading only the popup URL is insufficient evidence.
4. Keep profile identity immutable per page. Personal and named identities persist across tasks; temporary identities clear at last use and are excluded from saved state. Migration must preserve each historical native partition exactly without merging accounts.
5. Reference-count shared partition resources: network grants, permission handlers, proxy configuration, download dispatch and login handlers. Closing a task or a recovering generation cannot revoke another live page's resources.
6. Recheck identity enablement and policy revision at dispatch and after asynchronous authorization. Denial and ask rules narrow ordinary task authority; preserve guarded/autonomous/full_access semantics. Human input remains independent. Do not infer current login success from cookies or a previous tool result.
7. Keep file authority bound to the Session Workspace. Validate real upload bytes and pathname/open-handle identity; stage exports privately and publish through Harness file-import admission. Unknown outcomes cannot be retried automatically.
8. Treat download collection and authorization as separate states. Chromium can finish a buffered file despite pause. Keep unaccepted files private, block export until acceptance, and remove them on cancellation/disposal. Exercise both buffered completion and a still-live transfer.
9. Recover a failed page generation with stable identity and bounded retries; ordinary popup/window destruction is closure. Healthy resume is idempotent. Persist descriptors, not JavaScript heaps or form replay. Disconnect and restart must not repeat an uncertain action.
10. Keep native-only presentation strict. No hidden Playwright engine, independent Browser Host installer, WebRTC viewer, screenshot stream or iframe fallback. The installed module seed may include the Desktop backend while CLI/Web composition leaves it inactive.

## Keep the Agent interface useful

Use concise tool descriptions and structured page/error results. State the page target, operation result, relevant evidence and one actionable recovery step. Distinguish an action being dispatched, a page settling and the user's business outcome. Never expose partition paths, broker tickets, internal queue details or credentials to teach the Agent how to operate the browser. Failed/missing/stale targets should identify the problem and suggest list, inspect or resume, without repeating the internal implementation.

## Keep the product interface stable

Use the workbench's semantic theme tokens, shared controls, localized descriptors and shared destructive confirmation dialog. Map each page ID to a peer resource tab beside files; never add a nested Browser tab strip. Add → Browser creates a page and closing its tab closes that page; changing the visible tab or hiding the workspace only detaches presentation. Reconcile the canonical catalog while another panel is active, preserving order, human selection and local opens whose events have not arrived. Background titles, popups and Agent activity must not steal selection. Keep the normal toolbar free of profile labels and identity management; login reuse is automatic, and separate profiles and website rules belong in Browser options → Browser settings. Pending prompts/errors are page-scoped and survive tab changes. Shared settings/confirmation dialogs and overlapping blockers hide the native view without recreating it. Verify narrow and wide panels, both themes, keyboard navigation and focus return in Desktop, not just browser DOM fixtures.

## Verification

1. Add a failing public behavioral test in the owning package's `test/` tree. Prefer real temporary Runtime/Scope/storage fixtures; mock only the external transport when testing policy.
2. Run affected Browser runtime/core tests, Desktop lifecycle tests and shared renderer tests. Use the Web batch runner with `SYNERGY_TEST_FILES` for selected files; DOM/Playwright suites need its serial isolation and timeout. Never run the whole folder directly when suites launch Chromium or register conflicting mocks.
3. Typecheck browser-runtime, browser-core, Desktop and Web. Regenerate SDK after API schema changes; extract/translate catalogs and run `localization:check` after UI copy changes. Regenerate tools documentation after tool definitions change.
4. Run `SYNERGY_DESKTOP_RUNTIME_TEST=1 bun test test/browser-runtime-smoke.test.ts` in Desktop for native changes. The real Electron fixture must exercise at least eight WebContents, same-profile cross-task cookies, named isolation, native popup POST/opener, page closure, download acceptance and per-page renderer crash recovery. Test temporary partition cleanup and shared-resource survival when touching those paths.
5. Start an isolated Desktop through `develop-synergy`, with separate backend home, ports and Electron userData. Personally exercise tab creation/selection, identity creation and copying, permission editing, disable/enable/clear/delete, native rendering, reload/restart and cleanup. Inspect the rendered UI and browser content; successful HTTP responses alone do not establish acceptance.
6. Run the crypto contract and production private-HTTP smoke for capability/bootstrap changes. Web must start without browser hosting. For release/composition changes verify module inventory, source CLI/Web selection and Desktop packaging closure; a devDependency used by tests must not become a production browser engine.
7. Finish with `quality:quick`, an implemented decision record and matching architecture/product/Skill updates. Record actual coverage and remaining platform limits; a local macOS run does not prove Windows/Linux packaging.

## Focused regressions

- Concurrent input: hold an Agent observation while a real human gesture navigates; never use the lifetime of an Agent command to suppress human gestures. Native find, zoom, print and shortcuts target the explicit page and must leave ordinary input alone. Do not add takeover, hand-back or control-owner state.

- Workspace transition: held commands, page close acknowledgements, failed-close retries, cancellation and local-file recovery rejection.
- Authorization: profile disablement across tasks, cached command revocation, policy changes during approval, and every control profile's ask/deny semantics.
- Migration: fresh home, real v4 owner mapping, annotations/downloads, invalid identifiers, exact partition mapping, rerun preservation and untouched retired data.
- Recovery: renderer exit, CDP timeout, in-flight resume sharing, failure budget, native Retry and no action replay.
- Overlays: prompt defaults/empty text/cancellation, file chooser, overlapping menus/dialogs, focus return and preservation of the original native page.
- Agent evidence: settle defaults/caps, structured current/list output, ambiguity candidates, screenshot delivery to image/text-only model paths and bounded redaction.

Report the implemented behavior, local commits, generated contracts, automated checks and observed Desktop acceptance. Do not substitute mock-only checks for native behavior.
