# Decision Record: Scope release regression observations

Status: implemented

## Problem

Behavioral tests can fail for unrelated work when a global timer observer counts every Runtime or a short fixture deadline becomes an accidental storage-latency requirement. Those failures obscure whether stream completion semantics and Runtime cleanup are correct.

## Decision

The Cortex fixture observes retention timers only for its own Runtime and compares timer handles by identity. The regression includes an overlapping timer from a separate Runtime, retains the exact two-timer expectation, and verifies that fixture closure releases the owned timers without clearing the unrelated timer.

AgentCall semantic fixtures allow five seconds for their real storage-backed operation, within the unchanged test-runner deadline. Tests of cancellation, stalled streams, late stream disposal, deadline coverage across retries, and timer process liveness retain their explicit short deadlines. This separates completion correctness from incidental shared-runner latency without replacing the real recording and stream integration.

## Alternatives considered

**Count timers by duration alone.** Different owners can legitimately schedule the same duration; the observation must include Runtime ownership.

**Replace the semantic tests with a mocked AgentTurn.** That would remove recording and stream integration coverage instead of correcting an incidental fixture budget.

**Relax assertions or add retries.** These would conceal failures in completion evidence, cleanup or visible conversation positioning.

## Consequences

The tests preserve their original public behavior assertions and full CI selection. A stalled semantic fixture can take up to five seconds to fail, while dedicated deadline tests still fail at their original budgets. Browser background-return diagnostics include per-frame inner viewport geometry so a failure distinguishes missing content, measurement changes and scroll displacement.
