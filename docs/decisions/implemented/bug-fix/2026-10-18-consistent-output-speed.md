# Decision Record: Use one consistent output speed

Status: implemented

## Problem

The timing card and compact task summary display generation speed while the Token disclosure exposes request throughput. Different time windows and precision make the same task appear to have contradictory speeds. A user assessing responsiveness needs one value that includes the model request's initial wait.

## Decision

Task summaries, timing cards and usage disclosures use canonical `rates.endToEnd` with the concise label **Output speed** and one shared formatter with one decimal place. No second speed or explanatory qualifier appears in the interface. Missing request measurements stay unavailable even when generation rate is known; measured zero remains visible.

Harness retains paired output/duration aggregation, reasoning as a subset of output and existing sample exclusions. [Usage accounting](../../../architecture/usage-accounting.md#timing) owns the formulas and limitations. Generation rate remains available as diagnostic data. This supersedes the generation-speed presentation in [task usage details](../feature/2026-10-08-task-usage-details.md) without changing accounting or stored evidence.

## Alternatives considered

**Expose both speeds with different labels.** This preserves both measurements but leaves users deciding which value represents responsiveness and adds interface text.

**Use generation speed everywhere.** This omits the first-content wait and can overstate the speed experienced during a complete request. Client content chunks also cannot establish exact server decode timing.

**Divide all task output by task wall-clock time.** This incorporates tool execution and overlapping requests, changing the metric from model request responsiveness to task-level throughput.

## Consequences

All existing speed surfaces agree without API, migration or provider-capture changes. Browser tests compare them through live updates, unavailable and zero values, narrow sizing and keyboard dismissal. Accounting tests verify weighted sample aggregation and excluded evidence. The metric describes eligible recorded requests across the selected task scope, not instantaneous typing speed.
