# Interactive storage and durable input validation

## Scope and baseline

This investigation tested whether startup, historical navigation and the next message remain usable together after the runtime and transactional-storage changes. Measurements were collected on 2026-09-22 against the implementation accompanying this report, based on development revision `46954a21e`. The host was an Apple M5 Pro with 48 GiB RAM, macOS 26.6.2 and Bun 1.3.14. All writes, model calls, process faults and restarts used isolated test homes and alternate ports; the running user instance was not changed.

The [decision](../decisions/implemented/bug-fix/2026-09-22-interactive-storage-and-input-recovery.md) defines the accepted tradeoffs. The [postmortem](../postmortem/0026-started-runtime-stranded-saved-input.md) describes the failures. This report records local evidence, not a hardware-independent performance guarantee. CI enforces correctness without adding these latency thresholds.

## Fixtures and measurement boundaries

- Fresh: an empty isolated home, then persisted multi-turn conversations.
- Historical: 1,000 sessions expanded from the released v3.0.22 storage fixture, including approximately 320 KiB text bodies and the matching released migration ledger. Upgrade, historical visibility, saved-input recovery and subsequent conversation were exercised.
- Large: 21,018,204 hierarchy nodes and 10,508,034 records in a 16,803,053,568-byte current-format SQLite database. Its unrelated live hierarchy uses synthetic keys and roughly 300-byte bodies. SQLite `quick_check` returned `ok`. This fixture measures interference from a large unrelated table; it does not represent 21 million rollout owners or prove a production-sized format rewrite.
- Owner enumeration: a separate 200,000-record, 50-owner rollout distribution. Enumeration still scales with evidence record count; the large unrelated-key fixture must not be used to claim otherwise.

Startup measures `ProductRuntimeHandle.open()` through successful HTTP health with both storage workers ready. It excludes module import and does not purge operating-system caches. Five samples were taken per condition; the nearest-rank p95 of five is the maximum. Admission measures the public input request through its durable response. Canonical publication measures from submission until the status endpoint confirms the canonical message, including polling delay. End-to-end completion includes model latency and enabled auxiliary work.

## Startup and message results

| Startup condition                             | Samples | p95 (ms) | Local target (ms) |
| --------------------------------------------- | ------: | -------: | ----------------: |
| Independent fresh homes                       |       5 |  2,000.4 |            10,000 |
| First upgrade of independent historical homes |       5 |  2,723.3 |            10,000 |
| Reopen the fresh conversation home            |       5 |    514.5 |             5,000 |
| Reopen the historical conversation home       |       5 |  3,022.3 |             5,000 |
| Reopen the large current-format home          |       5 |    362.1 |             5,000 |

The real-model matrix completed three sessions of ten rounds in each of the fresh, historical and large homes: 90 successful rounds. Every round verified a single canonical input and the expected response through the public HTTP API. DeepSeek was the only remote model provider used.

| Home       | Rounds | Admission p95 (ms) | Canonical p95 (ms) | Completion p95 (ms) | Completion maximum (ms) |
| ---------- | -----: | -----------------: | -----------------: | ------------------: | ----------------------: |
| Fresh      |     30 |               13.1 |              226.0 |            12,457.7 |                13,420.6 |
| Historical |     30 |               36.9 |              328.3 |            11,758.4 |                74,496.8 |
| Large      |     30 |               19.9 |              237.9 |             1,815.1 |                 1,951.9 |

Admission and canonical p95 met the local one-second and two-second targets. The completion columns are not a like-for-like speed comparison: default Library and auxiliary calls remained enabled in the fresh matrix and the first 28 historical rounds. The last two historical rounds and the large matrix explicitly disabled Library memory, experience and autonomy work and preset the title. The original 240-request budget interrupted historical testing; after approval to raise the cap to 320, saved work was handled through normal product APIs and the remaining rounds completed. The 74.5-second maximum is retained rather than removed as an outlier.

A separate six-call probe disabled auxiliary work and measured submission through arrival of the first model request at an isolated forwarding gateway. One worker-cold and one worker-hot sample were collected per home, with one agent worker and no idle prewarming. These are individual samples, not a p95 estimate.

| Home       | Worker-cold dispatch (ms) | Worker-hot dispatch (ms) |
| ---------- | ------------------------: | -----------------------: |
| Fresh      |                   1,397.9 |                    219.3 |
| Historical |                   1,334.1 |                    170.1 |
| Large      |                   2,385.3 |                    215.9 |

All six samples met the local five-second cold and three-second hot preparation targets. They exclude remote response latency and do not establish those bounds for every auxiliary-task configuration.

## Cleanup and contention

The large fixture retained its unrelated records while 100 samples per operation exercised missing-key deletion, deletion of 128 addressed records, and point reads. Missing-key deletion p95 was 1.74 ms, batch deletion p95 was 45.13 ms, and point-read p95 was 0.27 ms. The deleted fixture branches left no residual nodes. This is evidence for addressed-key cleanup rather than namespace-wide scanning.

The committed storage benchmark additionally measured 1,000 transactions at concurrency 32, approximately 1,349 transactions per second, and queue-wait p95 of 22.98 ms. Its separate 200,000-record owner enumeration took 56.44 ms. An eight-reader/eight-writer mixed run measured read p95 of 0.21 ms and write p95 of 3.92 ms. These distributions differ from the large fixture and are reported separately.

Large expired evidence owners are deliberately deferred from online pruning. Explicit offline maintenance preserves atomic owner deletion and remains dependent on owner size and available disk space. Neither these measurements nor the foreground limits claim constant-time offline deletion or owner discovery.

## Recovery, backends and delivered applications

An additional real Synergy Max session in an isolated Git project submitted the same input concurrently, injected one provider HTTP 503, observed one completed `view_file` call with the fixture evidence, and verified one canonical user message. After closing and reopening the large home, the next turn recalled the file evidence without another tool call. Existing saved historical input was also retried through the product API after the pause and obsolete-root fixes.

Across preflights, failed attempts, the 90-round matrix and additional recovery/dispatch probes, the gateway reserved 282 of the approved 320 attempts. Of these, 281 were forwarded; 280 recorded HTTP 200, one had no recorded final status, and one was the deliberately injected local 503. Auxiliary calls and retries count toward the same cap. This accounting is not a claim that every original attempt succeeded.

Local correctness and application checks included:

- The final focused storage suite: 280 passed, three optional PostgreSQL cases skipped in that invocation. PostgreSQL 16, 17 and 18 were exercised separately against 47 storage-contract cases and eight subtree, budget, artifact and cancellation cases each.
- Fresh and upgraded SQLite formats 2 and 3; wide/deep complete pruning; bounded online deferral; active-owner and recency rechecks; transaction rollback; queue deadline/cancellation/ordering; writer suspension; reader replacement; terminal writer loss; and maintenance admission against active and already-admitted requests.
- Full harness, local runtime, CLI, server and product-runtime suites during implementation, followed by focused reruns for the final worker-exit changes. The product-runtime full rerun passed 1,510 tests. Final CI is the authority for the complete submitted revision.
- Full Web tests after the context-projection fix: 2,313 passed. Full Desktop tests: 304 passed and 15 platform/opt-in cases skipped. A separately enabled maintenance test exceeded 300 seconds successfully; the Electron startup/progress/recovery test also passed.
- Production Web build on private HTTP, browser crypto fallback, and an isolated managed Desktop cold start, rendered page, renderer reload and owned-server restart. No renderer errors were recorded in the managed Desktop probe.
- A managed Desktop first-turn fixture held the provider response for 35 seconds without falsely failing initialization. Subsequent turns exposed context-projection aliasing: the previous reply disappeared until reload. A failing store regression reproduced the identity rewrite; after the fix, turns six through ten retained every earlier reply before reload, and all ten remained visible afterward with no renderer errors. These Desktop calls used a deterministic provider and do not add to the real-model budget.
- Rebuilt macOS arm64 core and full binaries, each passing six installed-artifact cases outside the repository: completion, tool execution, file read, budget termination, timeout and permission refusal.
- All 17 local quick-quality gates, package checks, SDK regeneration and localization checks passed. A server-only coverage collection measured 71.1% function coverage, below its 75% floor; it omits cross-package hits and is not a passing aggregate coverage result. No coverage exemption or threshold was changed.

The reproducible correctness fixtures live under the owning packages' `test/` directories. The local benchmark is [benchmark-storage.ts](../../packages/harness/script/benchmark-storage.ts). Real-provider credentials, runtime homes, raw logs, identifiers and request contents are intentionally excluded from this report. Long-duration mixed-load results and final CI conclusions are recorded in the pull request's acceptance evidence, separately from the latency matrix above.

A separate 30-minute mixed-load run on revision `a8ccb47b7` completed 324 turns, 16 owned-server restarts, 65 duplicate submissions and 51,840 background writes without failures. Maximum admission and canonical-observation latencies were 58.0 ms and 413.1 ms. This runtime revision precedes the additional frontend context-projection fix; the Desktop checks above exercise that fix separately.

The two-hour run completed 676 turns, 33 owned-server restarts, 136 duplicate submissions and 108,160 background writes without failures. Maximum admission was 958.1 ms and maximum canonical observation was 2,473.7 ms while other builds and tests shared the host. Its long-lived parent loaded before the final obsolete-root, retry and worker-exit adjustments, while restarted workers loaded the current source. It is mixed-load recovery evidence, not a two-hour claim for one final immutable revision; the final-runtime 30-minute run and focused regressions cover those later changes.

Two shared-process CI coverage attempts timed out in the file-owned agent and worktree runtime teardown hooks. Their paired Linux coverage invocation passed all 75 cases; the same 24-file shard did not reproduce those teardown failures locally. That container shard had five separate failures: the mounted macOS dependency tree lacked the Linux vector extension, and four descendant-process liveness assertions failed in a container without an init reaper. It is not reported as a fully passing Linux product suite. The batch planner isolates the two file-owned runtimes without removing tests, extending timeouts or excluding coverage. The precise CI-only blocked resource was not established; final CI must verify the isolation result.

The following CI run passed those isolated fixtures but failed the inert-import directory assertion. Its 35-file coverage cohort passed all 441 cases on macOS; Linux reproduced the assertion with identical paths in a different enumeration order. Sorting both snapshots preserves the no-file-creation contract without depending on filesystem order. The emulated cohort was stopped after a later compaction fixture stopped advancing; that interrupted run is not a full Linux pass. The focused Linux coverage rerun passed all nine import and migration-reporting cases. The failure-summary regression also reproduced the loss of assertion differences after a blank separator; summaries now retain bounded differences and stop at the next suite.

## Disposition

The evidence supports indexed addressed-key cleanup, bounded online deletion, independent read execution, durable input identity and explicit retry recovery. It does not prove every production data distribution, provider behavior, hardware profile or historical corruption case. Historical roots and retained pauses were real defects found by the acceptance matrix and fixed with behavioral regressions. A usable upgrade requires completing a message after historical data becomes visible; startup health alone is insufficient.
