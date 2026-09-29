# Decision Record: Desktop browser pages and identities

Status: implemented

## Problem

Task ownership, browser-page lifetime and website login state have different scopes. Coupling them to one selected page makes popup authentication, cross-task login reuse and independent human/Agent work unreliable. A nested Browser tab strip and a permanent identity-management row also expose backend structure in the everyday browsing interface.

## Decision

Desktop is the only built-in browser host. Its bundled Electron creates one real WebContentsView per page. The backend owns task page records, immutable profile bindings, authorization and durable descriptors. Protocol v4 identifies Agent targets explicitly; human selection remains presentation state. CLI/Web composition omits browser hosting and its independent engine distribution.

Each webpage is a resource tab in the shared workbench strip beside files and other panels. Add → Browser creates a page, and closing its tab closes that page. Selecting another tab or hiding the workbench preserves the native context. A catalog subscriber reconciles titles, popups and closures even while another panel is active, preserving human selection and pending local opens. There is no second Browser tab strip.

Login reuse is automatic through a persistent default profile. Named profiles isolate accounts; temporary profiles disappear after their last page closes. Browser options → Browser settings contains the low-frequency profile and website-rule controls. Ordinary tabs show website titles without profile suffixes. A shared settings dialog hides native content without recreating it and returns keyboard focus to the durable menu trigger; destructive actions use the shared confirmation dialog.

Native popups adopt Electron's supplied child WebContents, preserving opener, POST and postMessage semantics. The initial native state is retained before asynchronous adoption, including a popup that finished loading before backend subscription. Partition proxy, permission, download and login resources are reference-counted across owners. The [Electron window-open contract](https://www.electronjs.org/docs/latest/api/structures/window-open-handler-response) determines adoption through createWindow rather than loading a second context from the popup URL.

Per-origin Agent access, upload and download rules narrow task permission policy. Disabled or missing profiles remain unavailable. Revision checks invalidate prior observations/authorizations, including approval races. File actions retain the Session Workspace authority; unapproved downloads stay in private staging even when Chromium finishes a buffered transfer. Cancellation and disposal remove unpublished bytes.

Session storage v5 persists descriptors and references a versioned profile catalog. Migration preserves each legacy native partition exactly, without merging accounts or deleting retired headless data. Restore is lazy; recovery uses stable page/profile identity and bounded native retries. Agent feedback distinguishes dispatch, settling and observed results, and unknown actions are not replayed. The [recovery and evidence decision](2026-08-30-browser-reliability-recovery-and-evidence.md) continues to govern those semantics; this decision owns page cardinality, product composition, protocol/storage versions and identity migration.

## Alternatives considered

**Keep one Browser container with nested tabs.** Rejected because webpages are workbench resources just like files; a second strip creates competing selection and close models.

**Expose identity controls on every page.** Rejected because default login reuse requires no management action. Separate account controls belong in settings, with explicit copying rather than changing a live page's profile.

**Retain headless and WebRTC hosting.** Rejected because duplicate engines, distributions and presentation lifecycles multiply state and recovery paths. The shared renderer remains reusable by Desktop without promising browser hosting to the Web product.

**Use the selected tab as the Agent target or lock an entire profile for human takeover.** Rejected because either choice makes unrelated pages and tasks interfere. Explicit page IDs preserve concurrent use and allow targeted user login.

**Replay navigation and forms after restart, or merge historical login stores.** Rejected because the previous action may already have happened, one-use authentication callbacks can expire, and account merging can switch the user's identity silently.

## Consequences

Pages, profiles, selection and authorization have distinct owners. This supports independent native pages and reusable login while keeping ordinary browsing compact. It costs a page catalog, partition reference counting, catalog/presentation subscriptions and explicit lifecycle reconciliation across the backend, Desktop and workbench.

Persistent cookies may survive restart; JavaScript heaps, unsaved forms, navigation history and in-progress OAuth transactions are not recovery guarantees. Temporary pages are excluded from recovery. Website-rule revocation cannot undo dispatched website effects and does not control every subresource request. Password import, password management and browser extensions are outside this implementation.

Behavioral coverage spans real Electron multi-page/popup/recovery and login isolation, runtime authorization/migration/file staging, and workbench page reconciliation/focus. Local Desktop acceptance uses an isolated macOS home and userData with fixture accounts. It does not establish Windows/Linux packaging or third-party website authentication compatibility; those require their own platform and website acceptance.

Cross-domain fixtures select the Desktop composition explicitly for Browser tool exposure, migrations and Home session descriptors. Full CLI/Web composition keeps Browser absent, and neither source CLI selection advertises a separate browser installer. Broker tests use a real local WebSocket to verify page-scoped ordering, dialog unblocking and destruction of pages created across disconnects.
