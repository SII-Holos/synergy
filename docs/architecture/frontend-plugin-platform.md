# Frontend Plugin Platform

This reference defines ownership between the App's existing domain controllers, UI API 5 presentations and the artifact generation lifecycle. Public author-facing APIs live in [UI contributions](../plugins/ui-contributions.md); synchronization invariants remain in [Frontend data sync](frontend-data-sync.md).

## Domain owners and presentation

Global SDK/synchronization, layout and workbench providers surround the plugin host. The host's public environment adapts those providers; it does not create another synchronization store. Route-bound session owners retain message windows/history, turn projection, draft cache, submission and workflow controllers. Default and plugin Shell/page presentations mount beneath those owners.

Default Shell and session layout use public Shell/layout services. The native conversation consumes `PluginConversationService`, including the one canonical turn projection and bounded render cursor. Native composer layout consumes `PluginComposerLayoutService`; the editor consumes `PluginInputService.editor`. Workflow, inbox and other host-owned controls are composed as named views. Presentation unmount releases DOM/scroll references; it does not dispose a draft or cancel accepted server execution.

Draft captures retain the original cache entry through asynchronous work. Mutations advance an owning draft revision. Failure recovery restores only the captured draft at the expected revision, preserving subsequent edits. Composer document revisions additionally protect edits, selection, preflight and completion ownership. These are distinct from synchronization sequence/epoch watermarks.

## Surface ownership

A component mount belongs to plugin + generation + server + Scope + optional Session + contribution + optional resource. Its lifetime owns requests, subscriptions, menus, commands, portals and native view bindings. Bound services check lifetime, identity and capability before acting and after asynchronous completion. Unmounting UI does not undo an operation accepted by the server. Command registrations publish only after their owning render transition commits; disposal before commit prevents publication.

Session collections adapt existing Scope state. Session detail reads adapt the active message window and parts. The domain controller retains paging, replay/reconcile, optimistic metadata and bounded rendering. No UI component creates an EventSource or performs an event-driven REST polling loop.

Workbench tabs and resource close policies remain in the workbench domain. Public handles update existing tab state, register owner-scoped close guards and preserve the persisted layout. Resource-open presentation uses the current native presenter and an identity-safe disposer; there is no fire-and-forget window-event transport that can silently drop an action.

## Generation activation

Plugin Kit emits one UI5 named-export module, explicit hashed style/resource metadata and a content-derived generation. The server validates paths, real paths, hashes, schema, compatibility and approval before activating a development generation. The App prepares a complete candidate registry generation before replacing registrations. Validation failure preserves the last valid generation; stale asynchronous results cannot install into its replacement.

The existing event connection carries `plugin.ui.updated`. Preview mode reloads the real App when a known generation changes. Production registrations use the same loader and lifecycle. One integrity-checked native module URL is shared by all surfaces in a generation; disposal removes owned registrations/references without pretending to unload the browser module cache.

## Appearance and recovery

The public Theme package owns semantic colors. Structured Skin data owns material and resource choices for finite public parts. CSS AST transformation scopes plugin selectors and identifiers and validates local resources. Owned portals carry plugin and Skin identity; protected decisions reset style ownership. This restricts accidental CSS effects, not trusted JavaScript authority.

Shell and Skin preferences are independent per-server records. Unavailable choices retain their identity and render defaults. Required extension outlets are checked after mount; optional omissions are explicit diagnostics. `safe-ui` is resolved before plugin evaluation and retained for the browser tab until normal restart. Authentication, authorization, reconnect presentation, native window controls and Browser ownership stay outside replaceable Shell responsibility.

## Verification

The root [real-host tests](../../test/plugin-ui5/) build and extract packed templates and samples, start isolated production hosts through the public authoring helper, obtain normal approvals and drive the production App in Chromium. App/UI domain tests cover stale identity, lifetime cleanup, generation rollback, composer preflight, message bounds, resources, portals and Browser presentation. Performance measurements must retain the same environment and workloads across the base and changed revisions; unit tests alone do not establish runtime performance.
