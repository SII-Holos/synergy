# Decision Record: Isolate the capacity measurement process

Status: implemented

## Problem

The organization synchronization capacity case measures the parent and three native processes while ten authenticated clients replay 10000 messages from 100 Sessions. Its process-reported RSS includes `process.resourceUsage().maxRSS`, a lifetime high-water mark. A shared test process also imports and executes sibling suites before the case starts, so its lifetime metrics and process context do not identify the capacity case alone. Its case-scoped OS sampler has a different observation window.

Controlled diagnostic first-100 executions retain production source, fixture source and native SQL counts while selecting the capacity name in either its single file or the original 31-file context. Their elapsed/CPU times differ even without executing preceding test bodies. These samples motivate separate measurement processes; full-profile setup, host variation and process context do not identify a unique timing cause. Original shared-batch failures remain evidence and are not reclassified as product passes.

## Decision

Register only `packages/organization-runtime/test/capacity-sync.test.ts` in the existing `ISOLATED_BATCH_FILES` set. The ordinary test/coverage executor gives it a fresh Bun parent and isolated test Home, then uses the existing per-batch JUnit, LCOV and timing paths. `ownsRuntimeFiles`, package preload, Runtime composition, test body and capacity child launcher remain unchanged.

Keep the file's stable hash partition. Remove it from its original shared batch without reshuffling sibling hashes and execute it exactly once as its own batch. Full inventory discovery and fresh report collection still require every selected file. The other original 30 sibling files retain their shared-batch assignment. The complete Runtime inventory remains unchanged. These are internal hash partitions; outer CI suites may repack complete batches by estimated cost, so their placement requires a fresh plan.

The capacity fixture explicitly selects the production connection defaults rather than a 25ms test heartbeat. A short heartbeat adds continuous presence reads and writes throughout history production and is a different workload from deployed defaults. Readiness stays within the original ten-second guard and requires the Service-owned authenticated, live socket plus completion of its serialized handshake and ACK operation. It does not await the first scheduled heartbeat or treat a received authentication frame as an accepted connection. Actual heartbeat and synchronization counters remain observations. This correction does not identify the unique cause of earlier timing failures or replace a complete capacity result.

Prepare the one long history before creating the remaining ninety-nine short Sessions. All three original Runtime processes start at the same point, and all one hundred Sessions, 10099 messages and the original attachment exist before sharing, draining and ten-client replay. One aggregate 240-second deadline covers the long append, subsequent Session creation and short appends; every original append RPC receives only its remaining time, and creation uses the same abort signal. The 600-second whole guard, native transaction size, pages, bytes, permissions and complete assertions remain. This changes preparation residency and scheduling, not the accepted shared dataset or a production performance contract. It does not prove the cause of earlier capacity failures or replace a new full-case result.

Within each original hundred-message transaction, create and await every Message header in its original sequence. Start only the independent text Part of an already-created header concurrently with later header I/O, retaining at most one hundred pending Parts and awaiting all before the transaction returns. Drain every started Part before rethrowing an original header or Part failure so rollback cannot race outstanding writes. MessageOrder stays under one sequential header writer; each Part retains its own message and Part identity, canonical projections and native commit event. This uses the same public writers and changes only fixture preparation scheduling: transaction counts, marker scans, attachment ownership, all data and assertions, page sizes and 240/600-second guards remain. A full original-case result is required; this does not establish the unique cause of prior CI failures.

## Validation

The root runner contract invokes the real `executionBatches()` planner over the discovered Runtime inventory and the capacity file's original shard. It requires a one-file capacity batch, identical sibling batches, the original partition and exact disjoint file coverage. It also verifies that `batchInvocation()` keeps the package working directory instead of selecting the Runtime-owning preload exception. The testing package's existing pinned isolation inventory includes the capacity file.

The original capacity case retains 10000 messages, 100-message native transactions, 100 Sessions, three real enrolled Runtime processes, ten clients, the 240s native producer budget and 600s whole-case budget. Every transcript, checksum, page, privacy, replay, attachment, release, zero-backlog, tail and cleanup assertion remains in the original fixture. The new grouping needs a fresh actual full-case result and complete coverage collection; diagnostic prefixes do not establish acceptance.

## Alternatives considered

**Subtract a shared-process baseline.** A process-lifetime high-water mark cannot identify which case allocated retained VM state or reached an earlier peak. Subtraction does not establish the capacity workload's own memory bound.

**Expand the performance guards.** Longer deadlines do not define the measurement parent and would weaken the original workload acceptance. The original 240/600-second bounds remain.

**Retry or skip the shared case.** Neither preserves a unique fresh measurement with complete coverage. The existing executor instead runs every selected file exactly once, with the capacity body unchanged.

## Consequences

The capacity parent has a measurement lifetime that begins with its own file. Process-reported lifetime peak RSS and the case-scoped OS sampler remain separately identified; neither measures all descendant memory unless explicitly collected. One additional sequential batch uses the existing report merger and exact collector. CI runner count, concurrency, retries, deadlines and product permissions are unchanged. Fresh isolation does not prove that sibling Runtime work never leaks, cure an unknown product performance defect or erase original failing shared-batch evidence.
