# Decision Record: Release health wait deadlines after settlement

Status: implemented

## Problem

The HTTP health provider wait races a provider build with a one-second deadline. When the build settles first, the referenced deadline remains active after the health response and can retain its asynchronous context or delay process exit. A bounded Runtime collection test alone cannot distinguish this timer from other retaining paths.

## Decision

The health wait owns its timeout handle and clears it in `finally` on every settlement path. Provider readiness, error reporting, the production deadline and settled-state fallback keep their existing semantics. No HTTP response or configuration schema changes.

## Alternatives considered

**Increase the collection test budget.** This leaves unnecessary deadline callbacks alive after completed health requests.

**Unreference the timer.** This permits process exit but does not release its captured context. Clearing the losing deadline addresses the resource owner directly.

## Consequences

Independent child-process regressions use a long fixture deadline and verify natural exit after successful and rejected provider builds. Existing timeout fallback tests and real HTTP Runtime collection checks remain separate evidence. This repair establishes deadline cleanup without claiming unbounded production memory growth or treating one successful collection run as a complete retaining-path analysis.
