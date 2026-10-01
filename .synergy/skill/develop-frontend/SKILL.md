---
name: develop-frontend
description: Implement or review Synergy Web and shared UI changes across apps/web and packages/ui. Use for components, contexts/stores, navigation, settings, dialogs, workbench surfaces, semantic icons, themes, responsive behavior, accessibility, frontend API calls, event sync, and product interaction changes.
---

# Develop the Frontend

## Read the Contracts

1. Read `apps/web/AGENTS.md` and [Web product contract](../../../apps/web/PRODUCT.md).
2. Read [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) for contexts, snapshots, events, streaming, composer intent, or loaded buckets.
3. Read [Browser runtime](../../../docs/architecture/browser-runtime.md) for Browser UI or Desktop/Web presentation changes.
4. Load `change-server-api` when the UI needs a new or changed server contract; load `add-tool` for tool-card presentation.

## Settings recovery

Theme and color-scheme selections apply immediately, while fonts, locale and other staged preferences use the footer Save/Cancel flow. Verify both boundaries rather than assuming every appearance setting shares one commit policy. Test same-mode theme changes on already-mounted content and portals.

Keep section resource dependencies explicit and lazy. Verify that a failing model or agent request cannot block unrelated sections, refresh failures preserve readable snapshots and staged fields, and retries only reload affected resources. Search indexes should reuse field descriptors; test real scrolling, focus and highlight cleanup after late mount or selection replacement. Route every dismissal through one guard, close the parent only after its discard confirmation has closed, and test server error responses through generated SDK calls with error propagation enabled.

## Library and statistics recovery

Verify experience states through the persisted reward status and generated DTO, including a failed stub with no intent and an evaluated zero reward. Test detail failure, duplicate reads, local retry and disposal independently of encoding. Unified search keeps result ownership by query and content group. Test a pending group under the real Suspense owner: independent fetches alone do not prevent the parent fallback from hiding ready results. Do not infer timestamps absent from a public summary. For sparse daily statistics, cover skipped dates, month/year and leap-day boundaries, snapshot-relative ranges and local date labels; a successful refresh must publish one response without a second compute request.

## Preserve State and API Ownership

Ordinary uploaded attachments leave model preparation policy to the server. Do not manufacture an explicit summary or exclusion policy from MIME type: that can suppress text and document extraction. Verify the actual composer payload through preparation and a provider request, including a random identifier present only inside the uploaded bytes; upload success and a file card alone do not prove delivery.

For optional components, use `useGlobalSDK().capabilities` and the built-in surface requirements. Test a core server and one selected component, including eager resources and reconnecting to a different selection. Keep plugin-owned surfaces independent of the built-in map; configuration field ownership still comes from `/config/domains`.

Observer targets delivered by asynchronous mount callbacks must be reactive element signals, with cleanup on unmount. Verify late mount and replacement against rendered layout or computed CSS properties instead of asserting implementation strings.

Treat resource and operation keys as opaque strings. Escape them with `CSS.escape()` before placing them in selectors in both current-selection and keyboard-navigation paths. Cancel deferred scrolling on selection replacement and unmount. Test actual rendered scrolling and selection with composite JSON keys, quotes, backslashes, Unicode and empty strings. Follow the same identity through upstream controls and repeat the original installed interaction after a local fix. For patched dependencies, test every shipped module form and preserve canonical values; selector escaping must not become a second persisted identity.

Solid JSX may evaluate to a function. Never distinguish a rendered trigger from a component with `typeof`; use an explicit component prop such as Popover `triggerAs`, and forward its event, ref, and accessibility props to the native button. Test click, keyboard activation, Escape, and focus return with the real Tooltip composition. For animated overlays, wait for content removal before asserting restored focus; a still-focused opener during dismissal does not prove the closing focus scope has settled. Retained hidden workbench surfaces must be inert without losing drafts. Route Escape through the active overlay first and only collapse the surface containing focus; verify two simultaneously open surfaces, a nested menu, a dialog, and an editable target in a real browser. When a responsive modal presentation unmounts, release its overlay without closing the underlying workspace domain.

1. Use stores for coherent keyed collections and signals for independent scalar state. Read project-overridable configuration from the current Scope through `useSync`; `useGlobalSync().data.config` contains global settings only. Test differing global and project values plus a Scope config refresh.
2. Apply same-identity entity updates with targeted setters and `reconcile`; do not replace a whole stored object for a one-field event. A single-entity projection may alias a transcript or another store bucket: when its entity ID changes, replace the pointer through `produce()` instead of reconciling at the object root. Verify that advancing the projection preserves the previous entity's ID, contents and visibility before a reload can repair the view.
3. Keep derived values one-way. Preserve composer resolution as explicit draft → session default → fallback; only explicit user choices persist upward.
4. Use generated SDK methods for ordinary internal HTTP routes. Keep raw browser transports only for WebSocket/EventSource/WebRTC, external URLs, platform fetch injection, and browser file/blob/download flows that the SDK should not represent.
5. Preserve Scope/directory parameters, authentication, error semantics, asset URLs, event `seq`/`epoch`, replay, and loading/error states. Directory ownership matching must preserve POSIX path case; case folding belongs only to Windows drive/UNC paths.
6. For append-only LLM streams, keep the full snapshot as recovery state while imperative renderers track an offset and consume only the appended suffix through the dependency's typed live-update API. Do not rescan the accumulated prefix or insert an independent character-rate playback backlog; reset from a checkpoint only when the append invariant breaks. Derive terminal presentation from explicit part or message lifecycle markers, not coarse session status or the presence of a later timeline part. Key imperative terminal transitions and enhancements by content identity so unrelated sibling updates cannot restart them.
7. Do not key the whole turn or message-role boundary by object identity: `message.updated` events land as fresh objects on every update, so a keyed `Show`/`Match` destroys and rebuilds the entire turn (tool-card expansion, scroll, and Markdown state included) several times per reply. Keep those boundaries non-keyed responsive updates, and instead isolate failures inside `Part` with an identity snapshot: capture session/message/part/type before child evaluation, render the ErrorBoundary fallback from that snapshot only, and never re-read the failed child's live props. Log the original error with stable IDs only; exclude message content, tool payloads, and workspace paths. Cover this with a real Solid lifecycle test that proves a secondary stale read cannot escape the local boundary.
8. Read session-shaped store fields through the session data view only: ui components use `useData().view` (`partsFor`/`messagesFor`/`permissionsFor`/`statusFor`/`inboxFor`/`hasInboxBucket`/`todosFor`/`dagNodesFor`/`questionsFor`/`cortexTasks`/`sessions`/`sessionFor`), app components use `useSessionDataView()`. Do not read `data.store.part/permission/...` or `sync.data.<field>[sessionID]` directly in render code — session switches race store intermediate states (missing buckets, released scope stores) and `createMemo` defaults stop applying after first compute, so a direct read can surface `undefined` and crash with a rotating set of TypeErrors. The view accessors apply their empty fallback inside the function body. Missing array buckets must resolve to the shared constants in `packages/ui/src/context/session-data-view.ts` (`EMPTY_PARTS`, `EMPTY_MESSAGES`, …) — never a fresh array literal, because the render chain's `same()` equality guards short-circuit on reference identity and a fresh literal would invalidate every downstream memo on each store tick. `hasInboxBucket` is the only accessor that reports bucket presence: use it to preserve an "not loaded yet" gate when `undefined` semantics matter (e.g. inbox loading state).
9. Callback parameters are accessors or raw values depending on the control: non-keyed `<Show>` and `<Index>` pass an accessor — call it (`param()`) before rendering or passing it into i18n values, formatters, or attributes — while `<Show keyed>` and `<For>` pass the raw value itself. Passing an accessor uncalled renders its minified source (the crash-page footer once displayed `Version: () => { if (!untrack(condition)) … }`), and calling a keyed `<Show>` or `For` parameter fails typechecking. Prefer the non-callback form reading the source signal directly when no narrowing is needed.

10. Publish page-owned entries in global reactive registries from `onMount`, after transition commit; synchronous setup writes can stage old entries and overwrite their cleanup during commit. Register all cleanup before returning, and use leases for state shared by overlapping owners. Test nested navigation and a suspended transition, asserting that old registry entries disappear, the visible page keeps its commands until commit, disposed loaders abort, and stale replies cannot mutate reopened state. See the [transition lifecycle decision](../../../docs/decisions/implemented/bug-fix/2026-09-07-transition-lifecycle-retention.md).

For user decisions and recoverable queue operations, retain state by request identity, keep structured errors, and reconcile uncertain transport results before retrying. A public preview is not a restoration payload: restore through the domain's original input and idempotent receipt. Verify delayed replies after a request switch, lost replies after server success, failed restoration, and stopped progress motion separately from pending state.

## Preserve Browser Capability Boundaries

1. Route ordinary App/UI identifiers through `generateUUID()` or `generateRandomBytes()` from the shared utility package. Do not call `crypto.randomUUID()` or `crypto.getRandomValues()` directly from browser source.
2. Use `generateSecureUUID()` or `generateSecureRandomBytes()` for authentication state, nonces, credentials, and other security-sensitive values. A missing secure source must fail only the affected operation; it must never fall back to `Math.random()`.
3. Keep optional browser APIs out of module-scope startup paths. Gate Clipboard, Notifications, credentials, media, and other Secure Context capabilities at the owning action and provide a local unavailable or error state.
4. Treat non-loopback private-network HTTP as a supported Web deployment. When capability or bootstrap code changes, verify an actual non-Secure Context rather than relying on localhost.

## Localize Product UI

Read [Frontend localization](../../../docs/architecture/localization.md) before adding product copy, accessibility text, locale-sensitive formatting, or language settings.

1. Use the App-owned Lingui runtime and explicit semantic message IDs in the form `{domain}.{component}.{semanticKey}`. Use runtime descriptors or `<Trans>`; do not use Lingui macros, dynamic IDs, language branches, module-load translation calls, or sentence fragments assembled in code.
2. Keep descriptors statically extractable with an English default message and a translator comment when product context is not obvious. Use ICU variables, plural/select syntax, and component placeholders for complete messages.
3. Translate Synergy-owned chrome, actions, states, recovery guidance, and accessibility labels together. Keep user, LLM, Note, source-code, terminal, browser-page, plugin-author, brand, path, identifier, and raw diagnostic content verbatim.
4. Use the shared active-locale formatter for dates, time, numbers, percentages, currency, lists, and relative time. Do not hard-code locale tags or use a regional locale to imply an unrelated preference such as 24-hour time.
5. `apps/web` owns locale state, catalog loading, Settings, persistence, bootstrap mirror reconciliation, and the global `I18nProvider`. `packages/ui` consumes that provider through peer dependencies; it does not create a second runtime, import App contexts, inspect browser locale, or own catalogs.
6. Keep the Settings language control global, responsive, and recoverable: Follow System, English, and Simplified Chinese apply without refresh, do not follow project Scope, and must preserve language self-names so a user can switch back after a mistake.
7. Run extraction after each coherent copy change, translate every new `zh-CN` message, remove obsolete entries, and keep strict compilation green. Finish with the repository localization contract so new hard-coded product text cannot bypass the catalog.

## Use Semantic Icons

Non-tool product UI expresses meaning through `packages/ui/src/components/semantic-icon.tsx`.

1. Name the user-facing meaning before choosing a glyph.
2. Reuse an existing token only when the new control has the same meaning. Similar appearance or location is not enough.
3. Add a new token to `packages/ui/src/components/semantic-icon.tsx` before using an icon for a new product entity, navigation concept, state, setting, command, or action.
4. Choose a built-in glyph that is not already mapped to another semantic token. Reuse the existing token when the meaning is truly identical; do not create a second token that aliases its glyph. Avoid repeating a control's outline inside its glyph unless the inner enclosure carries an independent meaning.
5. When the glyph is new to the shared Icon component, register it in both `packages/ui/src/components/icon.tsx` and `packages/ui/src/plugin/builtin-icons.ts` before referencing it from the semantic map.
6. Render through `getSemanticIcon(token)` and type stored metadata as `SemanticIconTokenName`.
7. Keep raw icon names inside base icon controls, file-type/icon registries, tool-card plumbing, or plugin-provided icon paths. Built-in Plugin host UI still uses semantic tokens. Tool icons follow `add-tool`, not the product semantic-token registry.
8. Route Composer completion, annotation, revision-checked edits, and normal-message preflight through the single `ComposerDocumentController`; do not let features or plugin adapters read and mutate contenteditable independently. Keep Composer and selected-text snapshots transient and out of sync/replay stores.

Run `bun test test/semantic-icon.test.ts` from `packages/ui`. It rejects duplicate glyph mappings, missing shared registrations, raw JSX icon literals, and raw icon object metadata outside the documented base/tool/plugin-data exceptions.

## Preserve Product Presentation

For workbench visual changes, read the column, input anchor, surface and motion rules in [PRODUCT.md](../../../apps/web/PRODUCT.md) before changing a component. Compare the real new-task → first-send → reply → switch-and-return flow in both themes, with the same data and viewport. Check the actual computed surface after workbench overrides and portal scoping, not just the theme source. Reserve trailing action space and verify hover, focus and touch without changing the title's width. Keep greeting and Composer extension views mounted once.

Use `test/components/session/workbench-layout.dom.test.tsx` for input anchoring, bounded growth and shared-column geometry, and the existing draft, submit-lock, attachment and editor tests for state ownership. Verify native paste → undo → redo with selected text, multiline input and literal markup; direct Range mutations can display correct text while bypassing the browser's edit history. Run DOM suites through the App runner or one file per process. Record real native IME separately from synthetic composition events; pasted Chinese text does not establish candidate-confirmation behavior. At 375px, short height, 200% zoom and reduced motion, verify the final action remains reachable. Update this workflow and the owning product rule when an accepted visual decision changes; do not copy a page-local palette or introduce a second layout constant to patch drift.

For retained resource tabs, display the resource's owning Workspace independently of the Session's current selection. Keep encoded resource identifiers in persistence and routing; use the resolved panel title for visible labels, tooltips and accessible tab/close names. Verify the visible directory, file tree and recovered draft after switching and reloading.

Derive activity steps and counts from canonical tool parts. Display preferences must not schedule background inference or make session completion depend on presentation work; historical derived summary metadata does not control grouping.

1. Reuse shared workbench, dialog, form, toolbar, and surface primitives before creating local variants.
2. Preserve polarity: dark content/selection surfaces step brighter inward; light surfaces step darker inward.
3. Use semantic color/type/spacing tokens. Reserve state colors for real state rather than decoration.
4. Keep controls labeled, keyboard reachable, focus-visible, WCAG AA, reduced-motion safe, and usable at narrow widths.
5. Implement loading, empty, error, disabled, and reconnect states as first-class behavior.
6. Update `PRODUCT.md` when an interaction or visual rule should survive refactors.
7. For imperative renderers, use the dependency's typed live-update API and cover it with a boundary test. Do not hide an unsupported method behind a cast; same-mode theme changes must repaint already-mounted renderers.

For streaming-sync changes, test a checkpoint followed by a delta in one hidden-page flush, both with and without an existing part. Exercise background repair against the actual store provider while entering history and while compaction is pending. Evaluate all snapshot rejection conditions before advancing a resource watermark; preserve stronger reload ownership when requests share a loader.

Rewind and redo must converge through the server's effective message window, including retained caches with earlier rollback branches. Observe rollback identity and redo-validity transitions separately from ordinary metadata events, force message reloads after transitions, and verify removed messages also lose their part buckets without reconnecting. A new root can invalidate redo without changing the rollback ID and expose previously prefix-hidden injections. A latest rollback summary is only an immediate display filter; it cannot reconstruct the complete history projection.

## Preserve Loading Boundaries

1. Register optional built-in workbench panels with `WorkbenchPanelEntry.loader`; do not statically import Notes, Files, Browser, Terminal, or Review implementations into the route shell. Browser pages are resource tabs in that same strip; follow [change-browser-runtime](../change-browser-runtime/SKILL.md) for page reconciliation and settings. Do not nest another Browser tab strip or expose backend profile terminology in the everyday toolbar.
2. Keep heavyweight feature engines behind the interaction that needs them: Tiptap and Mermaid behind Notes, Monaco behind file Source view, and Ghostty behind Terminal.
3. Do not evaluate JSX child getters to detect detail presence: use an explicit availability value or property presence, then instantiate children only inside the mounted disclosure. Test closed → open → closed imperative-renderer counts. Bound tool previews and retained expanded-render caches by capacity; use resource identity to open full content on demand. See [bounded tool rendering](../../../docs/decisions/implemented/bug-fix/2026-09-07-bound-tool-rendering-memory.md).
4. Import only fonts used by the active product typography contract. A dormant family must not be emitted by the default App build.
5. Preserve `apps/web/test/app-build-css-contract.test.ts` as the production build regression gate for initial module preloads, emitted product fonts, and core compiled CSS. CI consumes the verified full-distribution Web build via `SYNERGY_WEB_BUILD_DIR`; standalone execution builds an isolated fixture. Share compiled UI test modules only with complete input/output validation and fresh processes and DOMs; settings regressions assert actual interaction and saved values rather than source strings.
6. Keep the Web HTML entry in Tailwind's explicit source inputs when moving package roots. Validate the built HTML and CSS together in a browser with overflowing sidebar content and composer focus: the root must stay within the viewport and the list must scroll without moving the document or navigation header.

## Change Themes and Color Tokens

Read `docs/reference/frontend-theming.md` before changing the color contract, adding a semantic token, integrating an imperative renderer, or authoring a selectable theme.

1. Use `packages/plugin/src/theme/tokens.ts` as the exhaustive color-token catalog and its `resolve.ts` as the only palette resolver. The UI theme package re-exports the public contract and owns runtime application. A theme supplies light/dark seeds plus optional typed overrides; do not create a parallel CSS palette.
2. Use a canonical token in Tailwind utilities and CSS variables. If the required meaning is absent, add it to the token catalog and resolver before using it. Do not invent consumer aliases such as `surface-*-soft`, `surface-muted`, or unregistered status text names.
3. Edit `packages/ui/src/theme/themes/synergy.json` for Synergy-specific seed or override values. Run `bun run --cwd packages/ui generate:theme`; never hand-edit `theme.generated.css`, `tailwind/colors.css`, or `theme.schema.json`.
4. Keep common text/background and status foreground/surface pairs at WCAG AA contrast in both modes. Preserve the product polarity rule independently of accent hue.
5. Plugin themes are complete structured JSON themes validated by the same schema and resolved by the same runtime. Do not add arbitrary plugin CSS theme overrides or theme-only token paths.
6. Imperative consumers such as Canvas, Monaco, terminals, and embedded documents must use the resolved theme tokens and react to the canonical theme-change event. Do not maintain component-local light/dark palettes or infer a theme change only from `data-color-scheme`.
7. Run the theme contract, artifact parity, and consumer-utility tests before visual inspection:

```bash
bun test --cwd packages/ui test/theme.test.ts test/theme-generation.test.ts
bun test --cwd apps/web test/testing/color-token-contract.test.ts
```

## Verify

1. Run the narrow component, model, or context test first.
2. Run:

```bash
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd packages/ui test
bun run --cwd apps/web build
```

For browser capability or bootstrap changes, also run:

```bash
bun test --cwd apps/web test/testing/browser-crypto-contract.test.ts
bun apps/web/script/private-http-smoke.ts
```

For localized UI changes, also run:

```bash
bun run --cwd apps/web i18n:extract
bun run localization:check
```

3. Inspect both themes, keyboard/focus, narrow layout, and loading/error behavior in an existing app or isolated second runtime.
4. At 375 px, check that overlay surfaces are named and keyboard-contained and that every interactive control remains inside the viewport. Open each changed lazy panel once to prove its implementation and resources still load.
5. Exercise Desktop when native Browser, window chrome, protocol, or Electron behavior changed.
6. Finish with `bun run quality:quick` when the change is ready for repository review.

## Handoff

When a menu suppresses its trigger Tooltip, preserve the trigger element and focus listeners. Exercise focus → open → Escape → focus return with the real composed controls. A menu action that opens a Dialog must hand off a connected return-focus target; an unmounted menu item is not one. Distinguish a visible path Tooltip consuming Escape from a parent dialog failing to close.

Report state ownership, API path, semantic icon token, shared primitives, accessibility states, tests, visual checks, and any durable `PRODUCT.md` or Skill update.

## Replaceable plugin presentation

Read [frontend plugin ownership](../../../docs/architecture/frontend-plugin-platform.md) before changing Shell, conversation, composer, resource or overlay composition. Keep domain owners above replaceable presentation and test their public services with native and external views. Capture draft identity before asynchronous work and restore only at an unchanged owning revision. Dispose DOM references, pending UI work and portals by surface identity; accepted server work keeps its domain lifetime.

For UI API changes, build the production App and run bun run plugin-ui:test. Its public preview helper installs extracted archives into an isolated real host. Also run the owning App/UI tests, private HTTP smoke, typecheck, localization and package gates. Browser fixtures must pre-discover their actual module entry so dependency optimization cannot reload the page during interaction assertions. Verify styles on ordinary inherited text and protected portals, not only elements that explicitly restate font variables.

Keep question and permission ownership above replaceable session pages. Native presentation may register an inline outlet; a missing outlet must retain an accessible host surface automatically. Bound the combined decision region, reset plugin style ownership, and verify both native and custom-page composition.

For navigation performance, test leaving the last Scope view for a global panel and returning, not only overlapping Session views. Retain recently viewed stores within the bounded inactive LRU, isolate panel data suspension below navigation controls, and verify canonical handoff convergence after a displayed timeout. A deadline sample must not replace the eventual completed navigation duration.

When a mutation replaces a collection (such as session tags), serialize pending edits and use the accepted response as the next edit baseline. Do not wait for an asynchronous event to update that baseline. Preserve failed input, expose retryable errors, and test a second edit before the first event arrives. Query filters must reach canonical pagination; filtering only the loaded navigation window cannot represent all matching history.

When changing file consumers, capture Workspace ID and binding generation before asynchronous work. Exercise the same relative filename in two Workspaces, switch while one read is pending, deliver stale-generation watcher events, and reopen a tab after a binding change. Preview URLs and editor models must retain the same owner as the file request.

For editable file consumers, capture the complete-read content version when editing starts. Keep that baseline independent from watcher refresh, and preserve drafts through model remounts. Test a remote write during editing and new local input during a pending save; only the submitted revision may become clean.

Workspace selection changes require catalog snapshot/event race coverage: deliver rebinding before an older bootstrap or Session response, retain the new Session generation without changing activity, and keep pinned file tabs on their captured generation. Conditional sharing/rebinding forms retain the revision observed when editing starts; incoming events must not silently authorize overwriting concurrent changes.

For filesystem actions, capture the Workspace, binding generation and observed entry version when opening the form. Retain input on conflicts and keep dirty source and destination drafts independent across rename events. Native create/delete notifications alone cannot prove a rename; verify the editor behavior against unrelated sibling changes.

For file-draft changes, verify reload as well as component remount, original content-version conflicts, Workspace generation separation, missing source files and local-storage quota failure. Preserve in-memory edits when durable backup fails and expose the recovery state in the existing editor.

For mobile drawers, use the shared modal stack instead of a document-wide keyboard listener. Test nested Settings and Escape, returning focus to each opener, releasing background isolation when the viewport widens, and keeping fixed actions reachable when collection content scrolls. A working-location summary must read the canonical session binding or explicit new-session choice; include null, missing binding, rebinding and pending creation cases rather than substituting the project directory.

For collection navigation changes, verify every existing category against its own projection and preserve nested ownership and pagination. Check actual category controls and list bounds at the minimum sidebar width in both supported locales; full-width controls plus outer margins must not exceed their container. Keep intentional resize hit areas separate from content-overflow assertions, and verify fixed controls while the collection scrolls. For independent disclosures, verify simultaneous expansion, preserved nested state and keyboard exclusion while hidden. Exercise keyboard activation with the real session typing-autofocus handler mounted; it must not redirect a focused control’s Space or typeahead keys into the Composer.

For Environment selection, test zero allocation when browsing profiles, conditional Session updates, stable creation request IDs after a lost reply, and draft restoration after startup failure. Activity recovery must address the original operation; never submit its command again.

## Complete workbench acceptance

Verify the complete built workbench from global and project new tasks through first send and an existing conversation. Follow [the product rules](../../../apps/web/PRODUCT.md) for task starters, working location and status. Keep their real controllers and status/detail components mounted in acceptance; a layout fixture with empty or substitute status is only a focused layout check. Test replacement cancellation, revision conflicts, attachment retention and editor focus after confirmation has restored modal focus. Select a valid fixture start mode and wait for the streamed reply and idle state; a new session URL alone does not prove successful submission. Exercise project and file entry buttons through their real dialogs and chooser.

For native chrome, inspect actual macOS traffic lights, dragging, minimize, fullscreen and exit, including collapsed sidebar and narrow split panes. Keep host control protection outside replaceable Shells and test a non-built-in Shell reserve. Measure button and icon bounds across default, hover, focus and opened menus within 1 CSS px. Capture both themes and real menus, checking popup collision, Escape/focus return, 375px width, short windows and 200% zoom. Under reduced motion, inspect computed styles while the menu carries its open state: the media rule must override the state selector's specificity. Overall visible coherence is an acceptance requirement alongside automated results.

For built-in navigation changes, verify the registered Shell in the production page, not only a manually constructed DefaultShell fixture. Registries may copy entries, so object equality cannot identify a built-in entry. Test full collapse, zero actual occupancy, retained width/scroll/disclosures, inert descendants and focused-control recovery on session and non-session routes. An ancestor’s `visibility: hidden` alone is insufficient when a disclosure explicitly restores visibility: inspect the rendered closed page. Keep restore/Search/New in the top row and preserve the mobile drawer and third-party Shell contract.

Configuration density is role-based: only the primary model selector retains its chevron; toolbar thinking uses its optional presentation while form controls remain unchanged. Verify real Agent, permission and working-location menus after removing the entire arrow wrapper. Add comes first as a circular control, and existing section metadata must produce real groups with one keyboard-navigation owner. Exercise model search with no, few and many results, long names, bounded scrolling and footer reachability.

Pin global workspace controls to the owner spanning both panes, not the pane that shrinks when opened. Compare the same button's viewport coordinates before/after toggling and resizing, preserve its focus, and verify tab hit areas remain unobstructed. For working-location typography, compare computed styles on the nested visible labels across new and existing sessions. Model selection markers need their own reserved trailing column; test badge alignment and long-name truncation before and after selecting a different row. Keyed lists compare selection by the supplied key rather than object identity; rebuilt catalog or search results must retain the selection marker.

Native titlebar acceptance must include OS-level coordinate clicks on restore, Search, New and the workspace toggle, plus a window drag from the empty header. Renderer-injected clicks and accessibility activation can bypass native drag hit testing. Check actual drag rectangles against controls in sibling or portaled subtrees; `no-drag` on a button alone does not prove that an overlapping drag owner releases it. Repeat after sidebar collapse and with the side workspace open. See the [escaped native hit-test failure](../../../docs/postmortem/0035-native-titlebar-swallowed-controls.md).

For project-entry changes, test the real Prompt provider and project picker together: destination-first merging, both revision checks, cancel, upload blocking, same-connection ownership and file-reference provenance. Verify independent section saves and unsaved dismissal in project settings. Inspect real computer/project/main-folder and Worktree controls at narrow and short viewports, 200% zoom, both themes and keyboard focus return. Folder selection must retain the underlying dialog state and distinguish the connected service from Desktop's machine.

Use the shared Dialog footer for actions that must remain reachable while project forms or directory results scroll. Cover short windows and keyboard focus return. During directory loading, edit the path before the response arrives and verify that the response preserves the newer input.

Project creation must remain a real two-field flow with a small computer selector. Verify per-connection directory staging, default-main creation, existing-project detection without renaming, failure retention and Composer focus after the modal closes. At least two actual repositories must participate in multi-folder acceptance: create from A with B shared, change main to B, and verify old tasks and A Worktrees still open, search, modify and clean up through their original bindings. Compare primary and additional roots in file tree, context picker, search and command tools rather than accepting a visual folder list as proof of access. New Worktree selection must allocate nothing until send. Exercise historical Worktrees with a non-Git or unavailable current main.

Inspect the shared controls in the real project Popover, create form, settings and service directory browser. Required sizes and timing live in PRODUCT.md. Check single-border input focus, separate menu/dialog shadows, fixed trailing checks, stable loading widths, nested Escape and focus restoration. Capture complete screens in both themes, narrow/short viewports, 200% zoom and reduced motion; isolated component snapshots cannot establish the combined page's density.

For Browser results, use the existing draft capture/retention API before asynchronous upload and reject a changed conversation. Screenshots and feedback remain editable until the person sends. Use Dialog size presets rather than competing max-width utilities; verify the footer and body scroll in a small Desktop window. Native overlay covers are bounded still images only, scoped to the selected page and cleared when native content resumes.

Build shared UI DOM fixtures in a separate process with the test environment. Vite can set `NODE_ENV=production` in its caller; do not propagate that mutation to test batches, whose Lingui fixtures require runtime message compilation.

## Resource Workspace changes

Trace shell presentation, resource references, navigation preferences and editing state separately. Document clicks replace the current same-type resource through its domain close policy; explicit new-tab actions preserve multiple documents. Test late saves, conflicts, deletion, local backup failure and refresh recovery against the captured document and baseline. Keep editor history in the document controller, and disable old-view transaction dispatch before retaining an unmounted editor. Persist manual Workspace choices and the one-output allowance; history, replay and background tasks cannot reveal it. Observe resource output through canonical assistant messages and their parts, not the user-only turn projection. Verify the 710px overlay and 520px navigation-drawer thresholds, user-size restoration, focus containment and both themes on the combined product page. The mobile modal host supplies accessibility and focus containment while the shared resource strip supplies its visible chrome.
