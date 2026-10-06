# Decision Record: Resource-first tool activation

Status: implemented

## Problem

The conversation's tool rows select captured invocation details even when the useful result is an existing note or native Browser page. This adds a second navigation step and separates the result from its editing or browsing surface. An invocation may arrive without resource metadata, Notes may belong to a different Scope, and asynchronous Browser lookup may finish after the user changes their selection.

## Decision

The App resource controller opens successful, unambiguous Notes and native Browser results through existing Workbench registrations. Shared ActivityTrace passes its optional ToolPart alongside the invocation identity without importing App resource rules. Note writes and edits require the returned note ID; single-note reads require one requested and one returned note. Active and archived Notes metadata lookup confirms existence and a unique current Scope rather than trusting the historical receipt's Scope after a document moves. Existing Notes tabs are activated without replacing their state, keeping drafts and close/save protection in the existing Notes owner.

Browser operations require a recorded page ID and resolve through the existing native catalog. List, close, untargeted, missing and unavailable pages retain execution details. Resource viewing never creates, resumes or replays a Browser page. Tool failures, business-error receipts, dry runs and ambiguous targets also retain invocation details. Historical calls load missing evidence on activation through the generated SDK and validate the returned invocation identity.

The controller captures connection, Scope, Session and current surface selection before asynchronous reads. A new activity choice or owner change cancels the request. Workbench tracks a transient selection revision for explicit tab/surface actions and resource retargeting, including switching away and back before resolution. Browser catalog synchronization updates the active tab only when its identity changes, so background title or URL updates do not invalidate a pending resource open. The optional canCommit predicate rejects obsolete resolver results before tab insertion; the controller activates only a still-current result. Resource selection exposes the tool row's pressed state only while the tab retains the resolved panel, resource ID and source. Automatic output reveal remains unchanged. This narrows the default activation rule in the [conversation process presentation decision](2026-10-01-conversation-process-presentation.md) while retaining its generic execution-details behavior.

## Alternatives considered

**Always open execution details** preserves a uniform inspection destination but makes users navigate again to edit the note or interact with the page they just created.

**Infer targets from tool input, URL or title** can select a failed operation, the wrong Scope or a different Browser page. Recorded result IDs plus canonical resource lookup keep navigation evidence-based.

**Replay or restore missing Browser pages** makes a viewing action mutate the runtime and can repeat network navigation or recreate a closed page. Missing pages retain captured details instead.

**Guard activation only after tab resolution** prevents visible focus theft but still inserts stale tabs after the user selects another target. Guarding Workbench commitment prevents that persistent side effect.

## Consequences

Tool results lead directly to their useful resource surface without adding another editor or Browser owner. Shared UI consumers keep their optional controller behavior. Resource lookup adds a lazy read for historical invocations and Notes metadata confirmation; unresolved targets remain inspectable. Browser viewing still requires native capability and an existing page. Real Workbench interaction tests cover tab reuse, keyboard activation, business errors, historical evidence, archived/missing Notes and obsolete asynchronous commits.
