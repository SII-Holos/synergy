# Decision Record: Flush worker text batches while the provider is idle

Status: implemented

## Problem

Checking a text batching window only when another provider event arrives leaves an isolated delta buffered indefinitely. A provider that pauses after sending text or reasoning cannot expose that prefix to the conversation even after the batching deadline expires. A streaming navigation test that mistakes an auxiliary title request for the foreground reply does not observe this gap.

## Decision

The Agent worker consumes batches through a deadline-aware async iterator. A pending text or reasoning delta races the one outstanding upstream read against its original 16 millisecond deadline. Deadline expiry releases the batch while retaining that same read for the next iteration. IPC delivery remains serial and respects its existing acknowledgement window. Adjacent tool-input deltas retain their call-based, size-bounded batching with a 250 millisecond deadline so native visual previews can arrive before a tool call completes; see the [native catalog decision](../architecture/2026-10-10-native-render-catalog.md).

Normal end flushes pending content. Early consumer termination clears the timer and closes the upstream iterator; a cleanup failure cannot replace an existing provider failure. No interval runs when there is no pending delta.

Production composer acceptance selects distinct foreground and auxiliary fixture models. It observes an unfinished visible reply on both sides of the workbench transition before allowing the foreground stream to complete. The fixture disables its server idle timeout because the test deliberately holds that stream across navigation; the bounded UI and whole-test deadlines remain unchanged, and cleanup releases the stream.

## Alternatives considered

**Rely on the next delta or terminal event.** This retains batching efficiency but cannot satisfy the latency bound during a provider pause.

**Send every delta immediately.** This removes the latency gap but gives up bounded coalescing during dense streams and increases IPC traffic.

**Send independently from a timer callback.** This introduces a second sender that can overtake lifecycle events or bypass downstream backpressure. Racing the pending read keeps a single delivery owner.

## Consequences

Sparse text and reasoning reach the reader without waiting for further model output. Busy streams retain the same metadata, ordering and batch-size limits. Each pending text batch adds one short-lived timer and at most one retained upstream read. Behavioral tests cover a paused producer, downstream backpressure, cancellation, normal end and preservation of the original failure.
