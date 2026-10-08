# Decision Record: Unified resource opening

Status: implemented

## Problem

Explicit source citations could become relative browser URLs, even when the target file existed in the task's Workspace. Managed attachments had an opening path, but file references, document-relative links and structured composer references did not carry the same navigation or ownership information. Reusing the selected Workspace could open a different file after a task changed its binding.

## Decision

`ResourceReference` is the portable parser and location schema. Explicit Markdown links, structured composer references, attachment controls and plugin resource requests converge on the host's asynchronous `resource.open`. The renderer identifies resources and displays file icons, link text and keyboard focus; the host resolves ownership, validates the Workspace generation and opens an existing reader. Ordinary inline code remains literal. External web links retain ordinary browser semantics.

Messages persist `referenceContext` with a Workspace ID, binding generation, captured root and relative directory, or an explicit absent/unresolved state. Structured file references also retain their own Workspace through editing, submission, restoration and transfer. The Session migration binds historical messages only when their recorded path and snapshot evidence identify one origin. It writes bounded batches and refreshes changed display headers in the same transaction, including records upgraded at ingress. It preserves ready projections so subsequent history reads need no full rebuild or writes inside read-only snapshots. Unproven history stays unresolved and asks the reader to select a Workspace when opened; it never substitutes the selected task's directory. The picker changes only the opening request.

A workspace-file target reads the current file in that recorded Workspace. An Asset target reads immutable attachment bytes. Review and snapshot actions retain their existing historical semantics. Location is separate from resource identity: line/column/range, document heading and PDF page requests can be repeated without discarding drafts or minting another resource. Missing files, changed bindings and invalid references report a local error with retry and copy actions; internal references never fall through to browser navigation. An unformattable reference only removes its copy action, never the error feedback.

One format capability table serves both file and attachment readers. Image syntax is a preview hint: known non-image file kinds retain their normal reader. Existing editing, immutable reads, byte limits and sandboxing remain owned by their domains. PDF and Office/media readers are shared. Markdown inside a workspace document resolves against that document's parent directory. Local heading navigation stays inside its document, including virtual blocks. Unavailable text positions clamp with an explicit notice; large text remains subject to the existing read-only preview limit.

Opening requests carry cancellation and captured connection/Scope/session ownership. The Workbench checks the request again before committing after asynchronous close protection. Source navigation retains its initiating focus target so a late completion cannot steal focus from another reference or the composer. Image controls and file links use the same host entry point. Resource observers bind inserted blocks, retain image URLs across unchanged renders and restore focus by reference occurrence when the original DOM owner was replaced. The plugin's public boolean indicates request acceptance; internal callers receive an asynchronous opened/dispatched/cancelled/unavailable result.

Text citations resolve ownership when activated; only inline images need a display URL during binding. Safe `data:image` payloads and browser `blob` URLs use an image target in the same parser and opener, preserving inline previews without granting external navigation to these protocols. Image tooltips use bounded labels instead of embedded payloads. Appending a block does not rescan or rewrite existing references. Copying a reference preserves its location and escapes filesystem identity, including UNC paths and reserved Asset route prefixes, so the copied target cannot change into a web link. Attachments without a URL copy their Asset identity or structured source location; the action is absent when no reference exists.

## Alternatives considered

**Patch only the relative link click handler.** Rejected because user Markdown, streamed output, attachment source actions and document previews would continue to disagree about ownership and locations.

**Infer every code-formatted filename and search for a matching file.** Rejected because commands, examples, duplicate basenames and historical workspaces do not establish an unambiguous resource. Explicit links and structured references provide that intent.

**Convert workspace files into managed attachments.** Rejected because a mutable current file and an immutable captured result have different meanings. Sharing resolution and readers does not require erasing those meanings.

**Retain separate legacy opening APIs.** Rejected because callers could bypass generation checks and reintroduce browser-relative navigation. Historical conversion belongs to ingress and versioned migration; consumers use one current pipeline.

## Consequences

The change adds durable origin metadata and a bounded historical migration. Old records without evidence require an explicit Workspace choice. A changed binding cannot silently inherit historical references, and opening a filename does not perform a global search. Current-file citations can become stale as code changes; exact historical evidence remains a Review or Asset resource. Unsupported formats retain metadata and download behavior rather than pretending to have a reader.

The canonical behavior and ownership live in [Workspace and files](../../../architecture/workspace-and-files.md) and [Sessions and messages](../../../architecture/session-and-messages.md). Immutable byte transport continues to follow the [attachment resource decision](2026-10-07-attachment-resource-references.md).
