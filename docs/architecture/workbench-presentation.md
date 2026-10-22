# Workbench Presentation

`workbench_view` presents existing resources in a frontend viewing the calling Session. Resource creation, editing, Browser navigation and native Computer input retain their own tools and authority. Generated attachments retain their normal delivery path; presentation is not an additional delivery requirement.

## Ownership

Workbench owns tool registration, request identity, frontend eligibility, pending requests and receipts. Server supplies a contribution on the existing global event WebSocket with connection-scoped sending, active-view updates and disposal. The Web application executes requests through its existing resource opener and Workbench panels. The portable schemas in `packages/util/src/workbench-view.ts` contain no connection, resource-loading or authorization implementation.

The resource opener retains canonical Note Scope resolution, captured Workspace bindings, immutable Asset identity, Browser page ownership, editor drafts and panel close policies. Presentation does not introduce another document controller, Browser runtime, plugin execution mechanism or permission engine.

## Targets and routing

Open targets identify a Note, a captured Workspace file, an existing Browser page or an immutable Asset. The host chooses the corresponding registered panel; model input cannot name arbitrary panel state, execute JavaScript, navigate a website or select an operating-system window. File requests capture the calling Session's Workspace and binding generation instead of borrowing the viewer's current directory. Precise file targets pass through ordinary read and protected-path classification.

File-bearing calls declare conditional resource needs to the existing tool resolver and retain precise read permission checks. Captured identity comes from its selected resources and the Session's Workspace ID, including object storage without a local path projection; the presentation tool does not acquire a separate local binding. Status and non-file resources do not acquire a Workspace. Equivalent file paths resolve through the canonical resource reference; a retained view also remembers the full panel resource identity so a same-path replacement in another Workspace cannot satisfy an old hide request.

A frontend advertises the matching presentation protocol and supported target kinds only while its executor is available. Its existing active-view interests identify the Scope and Session it is displaying. These interests select a destination; they do not grant resource authority. A request uses one eligible frontend, returns unavailable when none exists, and returns eligible identifiers when selection is ambiguous. An explicitly supplied client identifier must still be eligible. No request broadcasts to every open window or elects a global primary window.

## Requests and receipts

Commands travel as transient messages over the existing event connection, independently of canonical tool Parts and event replay. Each request binds the calling Scope, Session, invocation identity and selected connection. A receipt from another connection or an obsolete view cannot settle it. Duplicate invocation identities reuse the same request; changed input cannot reuse an accepted identity.

An applied result requires a frontend execution receipt. Sending a frame, completing a tool or observing a Browser host does not establish presentation. An open receipt identifies the selected resource view and its visibility. Content readiness is reported separately: an opened tab with loading content is not a loaded document or a completed website operation. The frontend receipt is application-state evidence, not proof that the person looked at the screen.

No frontend, unsupported targets, protected replacement and superseding user selection have explicit outcomes. Disconnection, cancellation or a receipt deadline after dispatch can leave an unknown effect. They do not authorize replay. Status can inspect a retained runtime receipt without resending the command. Runtime receipt retention is transient; a missing record remains unknown rather than proof of non-execution.

Reconnect, history loading, virtualized rows and retained Session remounting never execute old presentation requests. There is no durable UI command queue or new database format. Final tool receipts remain part of ordinary Session history.

## Attention and lifetime

An explicit Agent request may change the current resource selection. It does not activate the operating-system application or intentionally focus a document editor. Current keyboard focus, caret and drafts remain protected. Dialogs, presentation requiring a modal overlay and close guards can block presentation rather than being bypassed. Ordinary tool reads and edits retain the separate automatic output-reveal policy.

Asynchronous resolution captures the server, Scope, Session, Workspace binding and current selection. Cancellation, disconnection, a changed owner or a newer user selection prevents a late commit. Hidden retained Session trees cannot execute commands for another view.

Hide targets a returned view identity and changes presentation only. It cannot collapse a different newly selected resource, close a Browser page, stop a terminal or delete content. Viewing a Browser target selects an existing available page; it never creates, resumes or navigates one. Native presentation continues to follow [Browser runtime](browser-runtime.md).

## Extension and verification

New supported resources extend the typed target and the existing host resource/panel resolution. They reuse request routing, receipts and cancellation instead of adding one tool per panel. Arbitrary plugin panel state is not implicitly Agent-controllable.

Verification crosses the actual registered tool, connected client and resource opener. It includes absent and multiple clients, wrong-connection receipts, missing handlers, duplicate requests, disconnect and reconnect, delayed owner/selection changes, keyboard focus and dirty drafts. Removing the mounted executor must prevent an applied result. Helper-only tests cannot establish that the application consumes a presentation request.

The [decision record](../decisions/implemented/architecture/2026-10-21-confirmed-workbench-presentation.md) explains the alternatives. [Frontend data sync](frontend-data-sync.md) owns ordinary state projection and replay.
