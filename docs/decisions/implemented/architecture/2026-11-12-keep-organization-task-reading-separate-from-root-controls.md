# Decision Record: Keep organization task reading separate from root controls

Status: implemented

## Problem

Organization task navigation needs canonical Cortex child metadata. Rebuilding it from message scans loads cold history, while replacing the complete Session context with a child can redirect the Composer, resources or cancellation toward the wrong execution owner. Choosing a new transport for each child can also bypass a captured supervised member selection.

## Decision

Capture one private read dispatcher per directory binding and share it between root observations, the private transcript and task metadata pages. The dispatcher retains its supervised member or remote selection and validates each typed reply. Shared task pages use the generated synchronized metadata operation, bound to the root, source, sharing generation and immutable page watermark. Each panel retains at most its current metadata page; empty continuation pages preserve More, later pages resist first-page polling, and First explicitly returns to a fresh first page.

Keep the selected reading source independent of the root directory and resource state. A task changes the transcript, task directory and interaction source only. The main title and actual root Run observation stay visible. Composer input, pause, continue, cancel, resource changes, knowledge selection and artifact publication retain the original root identity. An explicit breadcrumb returns to the main conversation, and the input label names its root destination while a child is open.

The root destination label stays visible at narrow sizes even when a draft occupies the input. The actual paused observation replaces Pause with Continue; compact toolbar gaps preserve the existing touch targets while leaving more room for reading. Passing the minimum reading-height regression alone does not establish usable layout.

Changing the binding disposes the captured reader and selected child. Late task responses cannot restore the old source. A missing selected child returns reading to the main conversation; broader access, authentication or binding failures retain the conversation invalidation lifecycle. Private and shared child bodies continue through their existing message renderers and body residency limits.

## Alternatives considered

**Use the selected child as the whole Session context.** This changes command and resource targets as a side effect of reading.

**Discover children by scanning messages or shared snapshots.** This bypasses the native Cortex metadata index and loads history before a task is opened.

**Add a separate remote-only task transport.** Desktop would diverge from its captured supervised member reader and need an independent authorization path.

## Consequences

Focused metadata tests cover canonical parent/source identity, sharing-generation and watermark mismatch, empty continuation pages, later-page polling and cancellation of late replies. Full-App navigation checks distinguish the root control version and Run from the child, preserve the main draft through task navigation and assert root resource URLs. Browser geometry checks keep the child breadcrumb, input and reading pane reachable at narrow and desktop sizes.
