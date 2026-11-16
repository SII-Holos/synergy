# Decision Record: Preserve native Cortex handoff controls

Status: implemented

## Problem

A portable Session may own queued and running Cortex tasks. Cancelling those tasks loses their status and parent delivery intent; recreating them changes task identity and can repeat the original input. Native machine and delegated children also cannot acquire a fabricated human pause latch.

## Decision

Keep canonical task state on the child Session. Cortex reserves each native initial or structured-repair root before admission and records a versioned transfer hold on the existing delegation. The hold retains the exact handoff and aggregate root, input admission evidence, output and cost limits, absolute running deadline and independent continuation intent. The native repair count and exact pending initial-or-repair input remain on that delegation. A repair root interrupted before admission retains its original repair text rather than repeating delegated work. Suspending stops new capacity admission, pauses and drains the native writer, releases live capacity and timers, and leaves the task's queued or running status, output contract, Inbox and parent notification decisions intact.

Register Cortex with the public Session transfer owner registry. Owner export binds the canonical delegation with immutable evidence; Core retains the actual Session, messages, execution ledger and Inbox. Publication validates the proof and rebuilds a derived root-to-held-child index. The owning migration rebuilds that index from retained holds without guessing lost controls or creating a second task authority.

Only an exact cancelled-source or activated-target epoch, a separately admitted aggregate-root Continue and current execution-owner admission can release a hold. Continuation hydrates the same task and resumes its recorded native root through the existing Session continuation receipt and loop. It does not resend admitted initial input. A task that never admitted input uses its original reserved identity for its first native admission. Native startup reconciliation preserves transfer holds; an active cold task without such evidence explicitly blocks portability.

The synchronous Task tool delegates parent-abort decisions to Cortex. Only a native paused-turn reason plus the child's live hold, canonical parent identity and exact current transfer binding or maintenance operation preserves that child. A pause reason alone does not suppress ordinary cancellation, and a normal user cancellation still encounters the canonical hold rejection. The Task tool owns and drains its asynchronous cancellation work; a cancellation failure reaches the tool caller rather than becoming an unhandled promise or being replaced by the parent abort reason. Aggregate suspension must establish descendant holds before aborting their parents; this callback does not certify an unsuspended descendant.

## Alternatives considered

**Cancel and recreate delegated work.** This destroys parent delivery intent and can duplicate an uncertain operation.

**Write paused on internal children.** This changes the human and machine interaction contract to satisfy an unrelated transfer guard.

**Persist a separate portable task table.** The child Session already owns task status and controls; another authority would diverge after restart or completion.

**Suppress every parent-pause cancellation.** Ordinary parent stops still need to cancel unprotected delegated work. Only current native ownership evidence distinguishes controlled suspension from that ordinary stop.

## Consequences

Transfer holds and derived indexes add persisted state, but task execution and completion remain in the native Cortex and Session owners. Unknown plugin generations remain explicit portability requirements. A durable source draining intent is necessary before owner suspension, so a failed freeze can be cancelled and resumed with exact epoch evidence. Focused tests cover queued holds, actual native model suspension, cold hydration, one initial root, one parent notification and migration idempotence.
