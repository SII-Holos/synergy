# Decision Record: Observe large-history correctness fixtures

Status: implemented

## Problem

Large-history correctness tests combine canonical writes, projection preparation, domain reads and cleanup under one test-framework guard. A whole-case timeout does not identify the unfinished operation. Unscoped passthrough spies can also count another Runtime or Session after an earlier asynchronous fixture outlives its failed test.

## Decision

The Channel delivery-work fixture records the original root and three assistant writes and each original delivery/replay await. Its test-local phase measurement returns the original value or throws the original error and emits only stdout when `CI=true` or `SYNERGY_CI_TIMING=1`. Each fixture retains at most fifteen completed phase records and six fixed entry records; no per-message or per-Part logging, filesystem diagnostic output, query, timer, request or global environment change is added. Body and history read counters select the captured actual Runtime and Session, checking the explicit Scope on body reads when supplied. Same-owner duplicate reads still fail.

The five-thousand-history Channel case uses a 120-second whole-case correctness guard; the five-hundred-history case retains sixty seconds. Both retain the original history size, 2,001 extra Parts, exact four-body read order, zero full-history reads, reaction/reply outcomes and duplicate-delivery assertions. Their product execution and cancellation policies are unchanged.

The 130-family Digital Twin case uses a sixty-second whole-case correctness guard. Its complete workload includes canonical Session/message/Part writes, repeated background preparation, all-family statistics, the 96-reference bound, warm-query reuse and original stop/close operations. The 130 inputs cross the 128-row loading page and 96-reference selection boundaries. Its stage and completed-work counters are local RAM; at most eight stdout records cover family milestones 0/32/64/96/128/130, statistics and final cleanup. Milestone zero precedes Runtime startup. Completed prepareStep calls are counted from actual settlements rather than replacing the measurement with an expected step count. A hard framework timeout can delay or prevent finally output, so the last record establishes work completed at that point only.

These finite framework guards follow the existing [correctness test guidance](../../../../.synergy/skill/testing-guide/references/test-design.md). They do not replace product deadlines, background pause/foreground/WAL/disk policies, SQL budgets or explicit capacity acceptance. Neighboring tests retain their independent synchronization predicates.

## Alternatives considered

**Retain the short whole-case limits as performance acceptance.** The owning assertions specify historical coverage, current evidence, read work and delivery outcomes rather than elapsed-time targets. Their combined native and instrumented setup requires a separate finite hang guard.

**Change product deadlines, reduce history or retry failures.** Those changes would alter the behavior under test and could accept incomplete preparation or delivery. The full original workload and failed outcomes remain required.

**Count every process-wide spy call.** Another Runtime or Session can remain active after a failed asynchronous case. Selecting the original logical owner preserves duplicate detection without assigning foreign reads to it.

**Enable timing through a global environment change or shared file-writing helper.** Local stdout observation keeps its cost and lifetime inside the owning fixture and does not alter other tasks or diagnostic files.

## Consequences

These changes expose stage costs and permit the original correctness paths to settle under instrumented CI. They do not identify the cause of an earlier timeout, establish a production performance improvement or guarantee completion within the new guards. Original failures remain evidence; fresh owning runs must still complete all assertions and cleanup. The larger finite limits can retain a stuck fixture longer before failure, while bounded logs add fixed observation overhead. Production latency and capacity require their own unchanged acceptance.
