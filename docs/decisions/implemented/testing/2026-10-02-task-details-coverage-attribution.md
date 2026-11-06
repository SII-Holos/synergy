# Decision Record: Attribute task-detail coverage to its execution environment

Status: implemented

## Problem

The complete test matrix passes, but aggregate Web coverage rejects six task-detail files as never loaded. Chromium exercises compiled readers and virtual panels outside Bun's instrumentation, while the execution context and small controls lack direct source measurements. Package percentages alone cannot establish that every source file has an accountable test owner.

## Decision

An isolated, browser-conditioned Bun suite uses the existing Solid Babel loader with source maps to exercise the real execution provider, quick summary and evidence block. It verifies snapshot/event precedence, stale responses, reconnect cancellation, disposal, optional capabilities, retained child navigation, retry and current-text copying. Their original source paths appear in LCOV. The suite has its own process because its dependency mocks must not affect neighboring suites.

The reviewed coverage manifest identifies exactly three browser wrappers: panel, inspector and reader. Each names its compiled Chromium behavioral suite and instrumentation boundary. Those suites retain real virtual-list, modal, keyboard, long-content and evidence-integrity assertions; reusable trajectory, window and reader-state logic remains directly measured. No package threshold changes or directory-wide exemption are introduced. Deleted presentation entries lose their obsolete exemptions.

## Alternatives considered

**Load components without asserting behavior.** Import-only source probes would satisfy inventory accounting without testing state, actions or disposal.

**Lower the package threshold or exempt the entire execution directory.** Missing source measurements are independent of the percentage floor, and broad exclusion would hide directly testable state and content logic.

**Replace browser acceptance with simulated layout.** Bun's DOM harness covers reactive behavior but cannot establish real viewport, virtual scrolling or modal geometry. The compiled Chromium suites retain those responsibilities.

## Consequences

Coverage reports directly measure the small controls and asynchronous context. Browser-only wrappers have explicit, narrow ownership instead of implicit missing files. The matrix runs one additional short isolated suite, keeps all active-feature assertions and retains its existing aggregate admission gate.
