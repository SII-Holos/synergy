# Decision Record: Unified conversation process presentation

Status: implemented

## Problem

Independent display-mode projections make tool-rich turns difficult to scan and discard disclosure state when settings change. Repeated tool labels and recording diagnostics compete with the answer. Session creation and model selection leave an unresponsive interval before the first message appears, while inline tool results expand the reading column and complicate historical navigation.

## Decision

The shared UI projects one ordered process from canonical messages and parts. Consecutive ordinary tools form bounded mixed batches, separated by text, Scope, approval, deliverable and dedicated-renderer boundaries. Keys derive from message and part IDs. Full, Balanced and Minimal use this same structure and change only default disclosure; explicit choices take precedence. Balanced opens the current stage and closes untouched completed process only while following the bottom. Raw reasoning remains independently expandable; preview is opt-in without model calls.

The App retains disclosure in session layout through optional `conversation.activityView`. Optional `ResourceOpenController.openToolActivity` opens one lazy Execution details Workbench tab per Session. Selection retains server, Scope, Session, message, part and call identity. The default result opens captured operation evidence through a bounded read-only activity query, with cancellation and stale-response guards. Resolved evidence uses the resource's retained value during same-call refresh, preventing the Workbench Suspense fallback from hiding and restoring the entire detail content on each activity event. The retained value is still checked against its owning connection, Scope, Session and invocation before display. Pending refresh preserves content DOM, expansion, reading position and focus; events from another message leave historical selection alone. The heading names the tool rather than repeating its command or path; invocation intent appears once beneath it. Input, output and errors share a framed code-block presentation with independent copy controls. Lightweight preformatted text avoids constructing a file viewer for protocol data or output. File reads retain raw bytes, including Markdown, without preview/source modes. JSON object and search results use readable indentation. Preview size is bounded independently from copying the full captured text. Failed results retain readable error evidence without another disclosure or input JSON in Result. Parameters and diagnostics are secondary. Selection changes only through a tool-row action; the selected running invocation updates itself. Operation Diff, controlled media and attachments, Review, registered plugin results and modal presentation retain their owners.

The existing Session transition owner acquires a preparation lease before Session creation. It publishes immediate local feedback, accepts validated text after plugin preflight and atomically transfers the lease to the real Session ID. Navigation begins on creation; model selection still precedes actual input. Revision-guarded cleanup cannot clear a successor submission. A lost input receipt is checked through the existing durable input-status API before rollback: saved input retains its message and recovery owner, unavailable evidence stays pending, and missing input permits draft recovery. Drafts and model-selection revision checks remain in their established owners.

Process status follows the root execution ledger, stopped segments and canonical root-owned pause reasons. A past tool error stays visible without declaring a recovered turn failed. Stopping retains partial content and does not assert process termination. File-recording anomalies become a quiet Review entry; Review explains available evidence and restoration limits, including empty recorded changes. Streaming follows actual deltas and uses existing motion roles without a character playback queue. Reduced-motion rules override expanded modal state selectors, so opening execution details does not retain spatial entry animations. Modal Workbench presentation fills the mobile shell without a dock resize handle; its accessibility state follows the open surface rather than the desktop width limit, which can be zero at narrow viewport sizes.

The existing auto-scroll owner captures a DOM reading anchor inside a stable message/part row. Resize observation compensates detached reading through workspace reflow, disclosure animation and image loading. Restore callbacks validate their Session and scroller ownership and release with the viewport; explicit return to latest clears the historical anchor. The latest navigation uses a destination arrow, and the Inbox reserves horizontal space beside it in narrow conversation columns. This uses bounded rendered content without another scroll-state owner.

The timeline owns leading space between visible items, without trailing batch margins. Flat tool rows align the icon with the first text line, share a compact minimum height and emphasize selection through text and icon weight/color. Work duration and the secondary reasoning action share one metadata row. Conversation headings and emphasis use semantic weight rather than decorative rails. Diagnostics render native input once and put errors in a separate copyable block; returned content is rendered only in Result. Blocks use lightweight preformatted text, the shared clipboard controller and theme tokens, with individual keyboard controls and copy feedback.

Turn metadata starts directly with the process control, without a repeated Agent brand row. Individual tool failures retain accessible status and readable result evidence without a visible badge on ordinary rows or repeated counters in turn and batch headings. This avoids conflating a recoverable call error with the root outcome and keeps disclosure arrows adjacent to their labels. Canonical root failure and stop labels remain independent and visible.

Execution details distinguish tool receipts from process records. An interrupted process is labeled as interrupted instead of deriving failure from the tool's error receipt; a still-running process remains explicit even after the tool returns an error. Other tool errors remain readable. Command output is labeled and preserved verbatim, including partial output before interruption. Exit codes and signals are displayed only when recorded; signals alone do not establish user cancellation.

## Alternatives considered

**Separate legacy renderers behind the display settings** retain conflicting hierarchy and require duplicate fixes for identity, disclosure, scrolling and details. One projection keeps the options useful while making behavior consistent.

**A second pre-Session message store** introduces another reconciliation and retry owner. A presentation lease in the existing transition state provides early feedback while handing actual messages to the canonical optimistic and durable paths.

**Expanding every result inside the stream** increases reading displacement and mounts heavy renderers in the conversation. One lazy session panel preserves detail and historical selection; independent shared-UI consumers keep the optional inline fallback.

**Automatic generated process summaries** add inference latency, cost and nondeterministic claims. Labels derive from real actions, paths and lifecycle events, with raw reasoning available on request.

**Independent margins and filled selection rows** stack spacing at renderer boundaries and make a selected call resemble a persistent card. One spacing owner and text emphasis keep the reading stream coherent while visible keyboard focus remains independent.

**Appending raw results below parameters** duplicates fields on object-writing tools and mounts another result renderer in diagnostics. Separate copyable input and error blocks keep the secondary view specific without repeating the result. A toolbar-wide copy action obscures which content will be copied when both are visible.

**Formatting Markdown file reads as documents** creates inconsistent inspection controls by file type and makes the displayed content differ from the operation evidence. Uniform raw text blocks preserve the captured bytes; presentation does not reread the current resource.

## Consequences

The answer and deliverables remain readable while process detail stays accessible. Optional additive UI services preserve UI API 6 consumers and keep business persistence and ordinary HTTP semantics unchanged. The cost is a bounded presentation projection and a lazy panel selection owner. Historical selection may need one invocation query, and missing file-recording evidence remains an explicit limitation rather than a no-change assertion. Tests replace obsolete mode-specific rendering expectations with shared identity, detached completion, manual disclosure, stop, file-recording and detail-selection behavior.
