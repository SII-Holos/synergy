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

Use the workbench's semantic theme tokens, shared controls, localized descriptors and shared destructive confirmation dialog. Map each page ID to a peer resource tab beside files; never add a nested Browser tab strip. Desktop Add or Add → Browser creates a Scope-owned page without creating a Session or calling a model; closing its tab closes that page; changing the visible tab or hiding the workspace only detaches presentation. Reconcile the canonical catalog while another panel is active, preserving order, human selection and local opens whose events have not arrived. Background titles, popups and Agent activity must not steal selection. Keep the normal toolbar free of profile labels and identity management; login reuse is automatic, and separate profiles and website rules belong in Browser options → Browser settings. Pending prompts/errors are page-scoped and survive tab changes. Shared settings/confirmation dialogs and overlapping blockers hide the native view without recreating it. Verify narrow and wide panels, both themes, keyboard navigation and focus return in Desktop, not just browser DOM fixtures.

## Verification

For toolbar and menu changes, render the actual controls and inspect computed disabled, hover and focus styles plus bounds; variant names alone do not establish presentation. Use the shared menu variant as the sole painted surface, and forward Tooltip-composed trigger props to the native button. Keyboard navigation must exclude descendants of collapsed disclosures even when Chromium reports their layout rectangles. Test address suggestion selection, composing Enter, Escape dismissal, native visibility after the final blocker, and the new-tab import entry at narrow widths.

Initialize shared presentation from catalog metadata before creating its transport. Page panels must not reset shared presentation when mounting: transport state may already have arrived. Cover metadata reads without native allocation, presentation delivered before mounting, and peer resource switches using the rendered catalog and page panel.

For asynchronous Workspace opening, project a renderer-local tab before expansion and upgrade its identity only after canonical page observation. Keep pending tabs out of persistence; preserve catalog epoch/sequence guards and human selection when events precede the open response. Hold creation in rendered tests and cover the first animation frame, collapse/reopen sharing, explicit pending-tab closure, Session changes and stable-request retries after unknown outcomes. Import must open its dialog immediately, share the initiating preparation and bind every action to the captured server/owner/page/native bridge; exercise missing capability, metadata failure, target invalidation and recovery without dispatching an import during discovery.

1. Add a failing public behavioral test in the owning package's `test/` tree. Prefer real temporary Runtime/Scope/storage fixtures; mock only the external transport when testing policy.
2. Run affected Browser runtime/core tests, Desktop lifecycle tests and shared renderer tests. Use the Web batch runner with `SYNERGY_TEST_FILES` for selected files; DOM/Playwright suites need its serial isolation and timeout. Never run the whole folder directly when suites launch Chromium or register conflicting mocks.
   Cross-domain Browser fixtures must explicitly select the Desktop component set; ordinary CLI/Web fixtures must keep it absent. Check source CLI help, migration/tool registration, peer-tab behavior and shared theme/localization contracts when retiring browser surfaces. Remove coverage exemptions for deleted files and validate the manifest; retain behavior tests for the native broker itself, since child Electron smoke tests do not contribute Bun coverage.

   Keep API routing, native-ticket errors and asynchronous draft attachment directly measured. Draft fixtures must preserve edits during loading and reject a changed conversation. For Vite/Chromium-only wrappers, document exact behavioral suites in file-level coverage exemptions; do not exempt their directly testable logic. Isolate context-mocking suites in the Web batch runner.

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
  In native crash fixtures, observe the page's restarting/ready transition and replacement WebContents before evaluating the recovered document. Verify the crashed page loses its JavaScript heap while another page preserves its state; an immediately successful read can still come from the old renderer.

  Terminate only the fixture's renderer PID when injecting process loss, so system core-dump generation cannot delay the exit notification. Electron's [process and crash APIs](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetosprocessid) distinguish the renderer from the host. Keep bounded output available before EOF and cancel readers on timeout; a descendant holding a pipe must not hide the original failure.

- Overlays: prompt defaults/empty text/cancellation, file chooser, overlapping menus/dialogs, focus return and preservation of the original native page.
- Agent evidence: settle defaults/caps, structured current/list output, ambiguity candidates, screenshot delivery to image/text-only model paths and bounded redaction.

Report the implemented behavior, local commits, generated contracts, automated checks and observed Desktop acceptance. Do not substitute mock-only checks for native behavior.

## Local browser data

Keep password values inside Desktop’s OS-encrypted store and native form operation. Never return them through IPC results, logs or Agent tools; sanitize page-controlled exceptions from filling. Filling requires the exact website origin and never submits. Website data clearing preserves saved passwords and history; profile removal explicitly clears them. File imports are bounded, cancellable, preserve duplicates by default and report unsupported rows without secret values. Test temporary profiles, interrupted imports, exact-origin matching and unavailable system encryption.

Browser import uses one source picker, independent password/Cookie switches and per-type results. Keep the new-tab search centered and the import entry in its footer. Read only profile metadata during source discovery; request OS credential access only on explicit import. Keep source paths and decrypted values inside Desktop, and revalidate source paths and destination generation after asynchronous work. Test both local/account databases, read-only size/count limits, cancellation during OS access, domain-hash verification, host-only cookies and unsupported encryption/partition keys with disposable fixtures. Safari ZIP tests must include localized filenames; do not advertise native access on an unsupported platform or claim personal-profile migration from fixture acceptance.

Invalidate in-flight saves when deleting profile data. Query native navigation controls only after the page is ready; suspension and recovery are ordinary states, not background-probe errors. Keep tab menu addresses synchronized even when the website title is unchanged, and bind batch tab closing to the original task and surface.

Bind asynchronous navigation-state replies to the page and reactive request lifetime. Ignore replies after navigation, page selection or disposal supersedes them. Verify out-of-order replies through rendered back, forward and zoom controls.

## Shared project pages

Ordinary webpages use the unbound Scope owner; historical and local-file pages keep their Session owner. Capture the initiating Session’s Environment, Workspace generation and permission context before the page queue. Include Session identity in replay keys and Protocol v5 activity events, and let only the matching operation clear activity. Verify two tasks sharing one page with distinct Workspace bindings, cancellation, task deletion and binding transitions, plus real native create/browse/close while the Scope has zero Sessions. Metadata restoration must allocate no page; explicit empty-Workspace opening resumes the most recent page or creates a blank page.
