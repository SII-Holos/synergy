# Decision Record: Explicit session controls preserve user intent through interruption

Status: implemented

## Problem

Pause and abandon exposed different meanings across the composer, inbox and workflow owners. A hold could submit a draft on release, abandonment could leave queued work or a progressed Lattice Run resumable, and restart recovery could leave tool cards running without an execution owner. New input after a pause arrived only after another model call on the old instructions.

## Decision

Keep the [session pause authority](../architecture/2026-09-20-session-paused-state-authority.md) and serialize explicit session controls. Pause is persisted before execution can release. Abandon removes pre-existing inbox work at a cancellation fence, waits for the owner to settle, cancels queued rollout records, terminalizes the interrupted turn and calls the workflow owner's cancellation path. Only successful settlement, including cancellation hooks, clears the latch; failure remains paused and retryable. Lattice disabling retains its separate semantics.

Ordinary input on a paused session with an existing root uses the existing durable steer mode. The first resumed model call sees it on the original task. Only a paused session reopens its previous rollout; a new task after abandonment or run cancellation keeps the cancelled execution record terminal. Pre-wake repair closes any unfinished reply on that cancelled root before processing the new task. Accepted input reports its owning run separately from its message identity so the CLI tracks the original run when steering. Root model settings and workflow approval rules remain authoritative. Startup also settles orphaned tools on already-paused sessions without driving execution or destroying the breakpoint.

Keep the three-second hold shortcut and add a session-menu confirmation for discoverability and keyboard access. After the brief click grace period, a hold owns its release and cannot also send or continue. Pending, disabled, focus and explanatory states use shared product primitives and semantic tokens. Drafts, history and files survive abandonment; previously queued inputs do not.

## Alternatives considered

**Menu-only abandonment.** This is discoverable but removes the existing quick gesture. The menu complements a hold whose progress and cancellation behavior are explicit.

**Resume the old task and queue new input.** This can spend another model call following instructions the user just changed. Steering before the next call matches the paused composer's Send and continue action.

**Retain the old queue after abandonment.** This requires a separate parked state or can restart work after the UI reports it abandoned. Cancelling pre-existing queued work gives abandonment a definite end while later explicit input survives.

## Consequences

Cancellation can take longer because success acknowledges settled execution and workflow cleanup. Failures remain visible instead of releasing the session prematurely. Existing inbox modes and pause records suffice; no new persisted state or migration is introduced. Behavioral tests cover real leases and storage, first resumed input, restart settlement, cancellation failure and full pointer gestures, with browser validation of the native disabled-button path.
