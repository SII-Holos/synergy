# Decision Record: Task details and execution trajectory

Status: implemented

## Problem

Persistent execution controls below the Composer compete with task entry, while repeated message statistics mix cumulative usage and latest-request context. A large context summary separates users from recorded execution evidence and does not provide a coherent way to inspect retries, tool observations or retained child work.

## Decision

The neutral record icon in the conversation toolbar opens a 320px summary and links to Task details. Its internal ID remains `context`, preserving tab identity and placement. The overview has a compact height budget that can grow with text zoom. Three activity lanes provide an event-order overview and an expanded keyboard-operable explorer; time is an explicitly labeled alternate scale. Messages end with state, time and round details. The Composer reserves no execution-statistics or avatar space.

The toolbar and turn-completion row require the server's Workbench capability. A server without execution queries retains ordinary conversation content and actions without an unknown-status placeholder or a details action that cannot open its panel.

Task details replaces the Subagent Dock as the canonical Web view for recorded Cortex child tasks, including host-selected workflow reviewers. The unused dock, its barrel export and the former progress-panel entry are removed. Minimal servers retain public Cortex tooling and queries when installed, while the task-detail UI requires Workbench; no always-visible fallback strip is introduced.

Harness owns Rollout evidence, retained accounting and run lifecycle. Workbench projects those public records into scoped summary, trajectory, node and content operations. Stable node identity, filter-bound cursors and explicit descendant membership connect searches, selected rounds and nested delegation inspection. Raw content is lazy and UTF-8-safe; tool output preserves both the raw result and the model observation, and definitions come from the executed model request.

The default process reveals task activity rather than repeated request context. Recorded call relationships attach evidence, real retries remain explicit, and auxiliary purposes group only within actual owners and rounds. One filter menu replaces parallel dropdowns; active conditions remain visible and removable. Inspectors use titled, locally copyable text/JSON code blocks. Tool views are Result and Parameters and diagnostics; model request/response views retain actual retry navigation. Saved fields open directly without a raw/structured representation switch or directory selection. Timing is subordinate to the content, and block-local menus contain search, wrapping and downloads. Small JSON indentation affects display only; complete copy and download retain verified recorded bytes. A narrow inspector takes over all panel reading space and restores filters, branch expansion, visible identity, offset and focus on Back. At sufficient width, trajectory and inspector share 40/60.

The client overlays versioned snapshots and incrementals, recovering gaps around the historical window. Branches share the 500-node resident budget, the rendered window stays below 120 rows, and evidence caches have an 8MiB budget. A chunk-manifest index provides UTF-8-safe range reads. Sections and full-object search are derived from saved content. Complete copy and download bind one version and validate bytes/checksum with progress and cancellation; incomplete evidence cannot masquerade as a complete JSON object.

Historical reading takes ownership as soon as the user scrolls upward. Programmatic positioning uses the measured list offsets without scheduling measurement retries that could overwrite later user input. Reopening Task details without a target preserves its existing state; a saved tool error is readable as its result even when no result artifact was recorded.

Status reflects persisted root completion and active descendants, while elapsed time merges root execution intervals. Cumulative usage includes observed retries and descendants; latest main-request context has separate attribution. Missing or partial records are displayed without creating historical requests, charges or timings. Presentation notifications cannot invalidate committed execution evidence. A discontinuous evidence revision is recovered from the canonical snapshot before computing accounting; buffered updates are drained through asynchronous hydration, and a transient failure does not discard the root's live subscription.

Financial coverage separates reported currency amounts, estimates for other requests, subscription equivalents and missing evidence. An empty API category cannot imply zero spending. Verified official connections capture versioned prices at each physical request; boundary uncertainty produces an estimate range, and an owner migration preserves historical rates without repricing. Statistics and task details consume the same presentation. Lifecycle reconciliation revisits settled delegated roots after a later terminal reply so display accuracy does not depend on frontend guesses.

## Alternatives considered

**Retain the persistent bottom controls.** This keeps execution information adjacent to task entry but retains the visual pressure and redundant statistics that motivated the change.

**Keep a large context summary with a separate raw-message dialog.** This preserves the existing inspection surface but requires another transition to connect model attempts, tools and child lifecycles, and leaves most panel space occupied by explanations.

**Build trajectory state from visible messages.** This fits the existing message cache but loses requests outside the viewport, observed retries and retained tool evidence. The canonical persisted records provide complete search and truthful missing-data semantics.

**Render every request and every field control by default.** This exposes evidence immediately but repeats context and fragments the reading space. Type-specific inspectors and a process projection retain complete records while reducing the choices required for ordinary task reading.

## Consequences

Task entry gains space, and detailed execution evidence has one navigable surface with progressive disclosure. Workbench adds a runtime-scoped metadata cache and snapshot/event merge responsibilities. The frontend must preserve stable identities, bounded rendering, historical positions and focus across inspector and expansion transitions. Artifact bodies remain outside ordinary summary and trajectory updates. Product presentation is defined in the [Web product specification](../../../../apps/web/PRODUCT.md), and snapshot convergence is defined in [frontend data synchronization](../../../architecture/frontend-data-sync.md).
