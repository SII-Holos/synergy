# Decision Record: Task usage and performance details

Status: implemented

## Problem

Task summaries expose cumulative consumption without the breakdown needed to understand cache reuse, request speed or tool time. A static running glyph gives no visual activity feedback. The retained usage owner already measures these facts, so presentation must preserve its uncertainty and scope rather than infer new measurements from conversation time.

## Decision

Compact and full task summaries share a subordinate generation-speed and cache-hit row plus a Token disclosure. The disclosure separates input and its cache breakdown, output and its reasoning subset, main-task and descendant totals, request timing, retries and cumulative tool durations. Missing measurements are unavailable, measured zero remains visible and partial counts retain their lower bounds. Observed cache ratios identify their measured population; rates describe eligible request aggregates rather than instantaneous output speed.

Metric presentation uses concise names, values and necessary scope qualifiers. Calculation formulas, sample-coverage explanations and introductory paragraphs belong in the usage documentation; icon tooltips only identify their metric. Measured context category counts remain available in the full overview.

Workbench projects canonical latency, outcomes and tool statistics into the existing session execution summary and its revisioned events. Harness keeps accounting and rate formulas. Existing snapshot and event reconciliation carries all metrics without another polling or request lifecycle.

Only running status glyphs rotate. Reduced motion disables rotation, and terminal or queued states remain static. The nested usage disclosure uses the shared Popover and existing theme tokens with bounded scrolling and keyboard focus return.

## Alternatives considered

**Put every metric in the compact summary.** Detailed timing and token rows would overwhelm the task list. The subordinate row answers routine speed and cache questions while the disclosure retains exact values.

**Fetch global usage separately when opening details.** The execution service already computes the required values. A second request would introduce another snapshot, loading state and update lifecycle for the same task.

**Derive speed from total tokens and elapsed task time.** Input tokens and tool execution would contaminate generation throughput, and parallel descendants would distort the denominator. The retained usage owner supplies eligible samples and their measurement windows.

## Consequences

The summary and update payloads gain existing compact latency, outcome and tool aggregates without changing persisted state or provider capture. Both overview surfaces retain one presentation implementation. The disclosure can scroll on small screens, and providers without reliable generation timing may show cache data without speed. See [usage accounting](../../../architecture/usage-accounting.md) for measurement semantics and [the Web product contract](../../../../apps/web/PRODUCT.md) for presentation rules.
