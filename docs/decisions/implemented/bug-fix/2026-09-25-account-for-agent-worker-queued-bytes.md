# Decision Record: Account for Agent worker queued bytes

Status: implemented

## Problem

Agent worker admission and performance reporting share the count of serialized bytes waiting for a worker. Removing work without charging its insertion makes this count negative, weakens aggregate admission limits, and makes performance summaries fail their nonnegative schema validation.

## Decision

The shared enqueue operation charges each accepted task's serialized byte length before it enters either the interactive or background queue. Dispatch, queued cancellation, startup circuit failure, and pool shutdown release that same charge through their existing removal paths. Active worker payloads do not count as waiting bytes, and rejected requests do not change the count.

Behavioral tests cover both scheduling lanes, exact counts through dispatch and cancellation, shutdown and startup circuit cleanup, and aggregate admission across several individually valid requests. Cancellation must restore capacity without interrupting the active worker.

## Alternatives considered

**Clamp the reported value to zero.** This conceals incorrect admission accounting and permits more queued payload than the configured byte budget allows.

**Recompute bytes while collecting performance data.** Admission still needs a correct count before accepting work. Maintaining a separate reporting calculation leaves the queue's two consumers inconsistent.

## Consequences

The queue preserves its existing priority and lifecycle behavior while enforcing its byte budget and producing valid resource telemetry. Verification must exercise multiple accepted requests; rejecting one oversized payload does not establish correct aggregate accounting.
