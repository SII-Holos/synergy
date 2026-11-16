# Decision Record: Calibrate the capacity CI correctness budget

Status: implemented

## Problem

The capacity corpus is a regression sample, not a product quota or latency SLA. Its normal instrumented Linux execution completed the original 10000-message native preparation within the 240-second window and drained all 100 Sessions, but the 600-second test guard interrupted the subsequent ten-client replay. No independent business assertion failed before that interruption. A framework timeout does not establish completion of the remaining byte, memory, tail or cleanup checks.

## Decision

The whole capacity case has a bounded 900-second correctness budget. The original aggregate 240-second native preparation window and all product requests, authorization windows, leases and other scenario guards remain. The corpus still includes ten authenticated clients, three enrolled Runtime processes, 100 Sessions, 10000 long-history messages, 100 native transactions and marker scans, and the original chunked attachment. Every original paging, byte, permission, checksum, backlog, memory, tail and cleanup assertion remains.

The observed Linux preparation completed at 211.911 seconds, the held batch at 332.073 seconds, drainage with zero drafts at 518.199 seconds and replay began at 521.605 seconds. The corresponding complete local case passed all 6082 assertions in 269.019 seconds. Comparable preparation, held-batch and drain stages cost approximately 2.3–2.9 times their local counterparts. A 900-second envelope allows that observed execution surface while retaining a finite failure boundary. This is calibration of the test's allowance, not a measured performance improvement or a new service promise.

The capacity-owning Linux job has a separate 55-minute outer allowance; other units retain 45 minutes. The observed whole unit consumed 43 minutes 24 seconds with the interrupted case, so its old outer bound could cut off the calibrated inner allowance. The existing normal matrix derives this value from actual task package and capacity-file membership, independently of unit names or shard numbers. Selection, task graph, weights, runner, concurrency and coverage admission remain unchanged.

Replay also rejects consumption beyond the original captured message count. The existing counter only increases and successful replay already requires exactly that count and checksum, so this exposes an overrun earlier without changing a successful result. It prevents a repeated cursor from turning the fixed corpus into unlimited replay work. No workload is removed, moved outside the guard or replaced with seeded database rows.

## Alternatives considered

**Keep 600 seconds as a product performance requirement.** The sample defines bounded work and complete behavior rather than that latency SLA. The normal run made validated progress and exhausted the framework allowance after drainage; its full local result and observed stage costs provide a basis for calibration.

**Increase the budget solely because a test timed out.** A timeout alone cannot distinguish incorrect, unbounded or merely slower work. The original phase, native transaction, backlog and local complete-case evidence is required, and normal Linux still must execute the entire suffix.

**Continue changing preparation scheduling or add storage micro-optimizations.** These would change the measured workload or product code before identifying a new defect. The native preparation already satisfies its existing window.

**Reduce the corpus, relax protocol deadlines or skip final checks.** These changes would remove the acceptance being measured.

## Consequences

A hung case can consume up to five more minutes of runner time, and its containing job has ten additional minutes of outer headroom. The whole guard still bounds a stalled request, while the captured-count check bounds successful replay consumption. The existing complete local evidence is reused because the successful business path is unchanged; normal Linux must freshly finish the full corpus, memory checks and cleanup within the new allowance before this acceptance closes. A larger allowance is never reported as faster execution or as a passing result by itself.
