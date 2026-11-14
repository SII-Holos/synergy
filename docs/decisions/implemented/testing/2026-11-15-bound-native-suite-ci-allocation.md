# Decision Record: Bound native suite CI allocation

Status: implemented

## Problem

An Organization Runtime suite can occupy most of a hosted job while expensive native tests share that runner with Web verification or typecheck. A job can expire after beginning capacity work, leaving no complete suite result. Earlier case failures remain failures; the cancelled final case has no product-budget verdict. Two admitted top-level tasks can each own multiple real child processes, so a two-slot limit alone does not prevent contention.

## Decision

Organization Runtime uses four partitions through the existing suite partitioner. Each original stable batch remains intact; the existing six ordinary Linux units place partitions of one package on distinct runners. Four partitions avoid combining both previously long completed batches in one task, while keeping the original capacity batch intact. The executor retains the canonical package coverage command and selects disjoint file inventories. Every selected partition must contribute its original JUnit, timing inventory and LCOV before the unchanged package coverage floor can pass.

Harness and Organization Runtime suites declare the optional heavy task classification. The same admission predicate is used by placement estimates and execution: at most one heavy task and at most two top-level tasks run in a unit. Existing browser, Desktop, typecheck, artifact and native Workspace classifications remain. Light tasks may fill the other slot. Runner counts, workflow limits, product deadlines, workload sizes and capacity budgets are unchanged.

## Alternatives considered

**Raise timeouts or reduce work.** Neither addresses competing workloads or missing complete reports. Product and capacity assertions remain unchanged; correctness guards require their own causal evidence.

**Add runners or serialize every task.** Existing units and heavy-task admission can distribute complete batches while retaining useful light-task concurrency.

**Treat failed durations as accepted timing weights.** Failure and cancellation can truncate real work. They locate packing problems but do not provide successful timing samples or predict a passing execution.

## Consequences

Stable batch identities and exact inventory verification retain coverage across partitions. Resource classification may lengthen a particular unit's modeled schedule, which the existing planner rebalances. A changed layout requires a fresh complete current-head run; an offline packing estimate, local subset or cancelled old task cannot establish acceptance or a performance improvement. The allocation rationale complements the [batch and fixture efficiency decision](2026-10-04-ci-batch-fixture-efficiency.md).
