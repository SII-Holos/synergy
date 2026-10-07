# Decision Record: Bound asynchronous process RSS sampling

Status: implemented

## Problem

Per-PID synchronous command execution in resource inspection blocks the Control Plane event loop on macOS and Windows. Periodic resource collection and owner stats share that inspection path. Moving collection across an asynchronous boundary also permits process replacement, exit, cancellation and newer sampling generations to occur before a query completes; the old synchronous caller assumptions cannot safely carry across that boundary.

## Decision

Harness owns one asynchronous bounded inspection path, with platform batching where the OS command supports it and bounded procfs reads on Linux. Existing Registry and MCP owner APIs migrate atomically to Promises, and actual consumers await them without changing response schemas. Sampling commands remain short-lived query children, not a resident worker or cache. Detailed admission, deadline, failure and lifecycle semantics live in [process resource sampling](../../../architecture/runtime-and-scope.md#process-resource-sampling).

Only a current process owner and latest sampling generation may apply a sample or settle stale processes. Owned child liveness preserves unknown evidence rather than replacing it with a PID probe. Internal sampling deadlines preserve valid completed sub-batches; caller cancellation discards the full result. Registry's default OS sampler delegates the internal deadline to `ProcessInspection` and forwards only caller cancellation, rather than racing a second deadline that would erase partial results. Injected Registry inspectors retain their independent deadline and admission accounting until underlying settlement. Observability's periodic ticks skip pending work while explicit snapshots may supersede it, and event-loop lateness is measured before the RSS await. The one-second deadline and configured sampling interval remain unchanged. Failed measurement remains absent RSS with measured coverage explicit in aggregates. Observability shutdown returns sampling completion so Runtime shutdown can drain the new asynchronous work; periodic Plugin memory checks admit no overlapping query and cancel pending work when stopped.

## Alternatives considered

**Wrap synchronous spawning in an async function.** Rejected because it changes the return type without permitting timer or request progress while the command runs.

**Cache RSS or queue unrestricted per-PID commands.** Rejected because cached readings hide missing coverage and unrestricted execution moves the blocking cost into an unbounded process or queue backlog. Admission exhaustion instead leaves the sample unmeasured.

**Create a resident sampling worker.** Not selected: OS batch commands and asynchronous procfs reads can remove synchronous execution with less ownership and protocol machinery. A worker would still require bounded execution and exact process identity rather than merely shifting the same failure modes.

**Use PID existence alone as identity.** Rejected for MCP because SDK stdio PID ownership can remain visible until pipe closure after parent exit. Pinning OS start evidence improves attribution without importing SDK private child state. macOS second-resolution start evidence remains a known limitation, not a strict PID-reuse guarantee.

## Consequences

Source consumers of Registry snapshots/stats, stale settlement, MCP stats and Observability snapshots must await completion. HTTP stats fields and per-process failure representation remain unchanged. The Performance integration is limited to awaiting the two affected owner stats calls; statistical store reads are outside this decision.

The implementation removes main-loop synchronous RSS commands but does not establish the root cause of an observed production stall. Synthetic repeated probes of one PID do not establish a real-child load. Focused tests use distinct owned children and a delayed macOS command to prove event-loop progress, deadline/cancellation cleanup and preservation of completed sub-batches through both Inspection and Registry. Registry fixtures preserve unknown child liveness and terminator ownership, while resource tests separate RSS latency from timer lateness and require 700ms queries to produce frames at the existing 500ms interval. Windows command construction and parsing are unit-tested without a Windows runtime claim; Linux runtime evidence requires a Linux test run.

Strict macOS same-second PID-reuse exclusion is unresolved because `ps lstart` has insufficient precision and the SDK offers no public child-exit accessor. PID-only Registry entries also lack owned child-exit evidence. Failed initial MCP identity capture intentionally leaves the connection unmeasured. These gaps must be resolved or explicitly accepted before describing the change as satisfying strict process-identity acceptance.
