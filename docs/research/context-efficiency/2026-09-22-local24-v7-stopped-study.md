# Local-24 v7: study stopped before formal execution

The prospective [local-24 protocol](2026-09-22-local24-v6-protocol.md) stopped during real-provider preflight. Of 48 planned preflights, 21 passed admission and the 22nd failed environment cleanup; 26 were never started. None of the 48 formal task executions started. All 24 paired rewards, native task-test counts, solving times and task token comparisons are unavailable. The missing cells are not zero rewards or model failures, and this run establishes no task-quality or efficiency difference.

The fixed products remain v3.0.22 at `024dd683e091d9fce3d1d26b79b2e188ce636b52` and candidate `ecf1426a47bf8bbd13b13bd9c47d28b39bdeff05`. The [readiness inventory](2026-09-22-local24-v7-readiness.md) retains all 24 passing native references, 42 independently revalidated historical tool controls, 12 new deterministic controls and 24 prewarmed environments. These demonstrate preparation checks, not immunity to subsequent lifecycle failures. Twenty-two task payloads remain upstream originals; Cython and Stan retain their explicit dependency variant identities.

## Stop and diagnosis

The failing preflight was candidate / `terminal-bench-2.1/financial-document-processor`, the 22nd cell in the frozen order. It successfully returned the requested shell marker through the model/tool loop. Its native process exited 0 after 436.852 seconds, without interruption, forced termination or any recorded deadline expiry. The outer agent stage completed in 475.465 seconds and artifact collection completed. There was no native task grading because this was a connectivity probe.

After execution, `BenchmarkTrial._stop` bounded environment teardown to the frozen 60-second cleanup allowance. The retained cleanup marker reports `TimeoutError`; the compose log reports a container stop error. `environment-cleanup_failed` is the sole terminal evidence issue. The original admission receipt rejects that evidence, and the doctor exits 2. The driver dispatched neither later preflights nor formal tasks. This follows the [strict serial admission decision](../../decisions/archived/architecture/2026-09-22-benchmark-serial-admission.md).

Read-only Docker event recovery for this exact owned container shows SIGTERM at 12:12:39.073 UTC, SIGKILL at 12:12:49.221, container exit 137 at 12:13:21.512, and removal at 12:13:23.210. The 32.290-second interval between SIGKILL and recorded exit confirms delayed shutdown. Eventual removal does not erase the earlier timeout. The container exit is separate from the already successful native model process. Neither exit 137 alone nor this trace establishes OOM: the monitor observed zero OOM events, but also retained a sampling timeout. Sampled peaks were about 0.80 GiB container memory and 0.99 GiB summed process RSS, with at least 233.62 GiB free disk observed. Sampling is not a kernel maximum or proof that all resource pressure was absent.

The precise reason for delayed Docker/process shutdown remains unresolved. System Docker journal access was unavailable to the audit user, and no retained kernel wait trace establishes a deeper cause. The evidence does not establish candidate-product causation. The previous baseline bandit teardown failure remains a separate historical observation; later passing controls did not explain or replace it. Raising cleanup allowances or proceeding because the container disappeared would change the frozen condition, not repair this result.

A separate auxiliary title call timed out after its product-level 60,000 ms deadline. The native archive identifies its purpose as `title`, status as cancelled and error as an agent-call timeout; the product log corroborates the title timeout. The gateway observed its request for about 5.508 seconds without headers, response bytes or usage. Its unknown cost is retained. This cancellation occurred before native completion and independently of environment teardown; it was not the 600-second doctor deadline or the 10,800-second solving budget. The native log also records failed local embedding downloads and Library encoding, which did not prevent the connectivity roundtrip. No subsequent diagnosis called the paid provider.

## Independent evidence audit

The offline audit verified the complete recorded evaluator snapshot, plan digest, fixed source identities, serial order, single attempts, terminal seals and native archive readability. All 22 preflights occupy the exact first 22 schedule positions, with no overlap and no replacement attempts. The remaining preflights and all formal attempt directories are absent. The strict policy still rejects the failed attempt; its request evidence was examined through lower-level read-only reconciliation without altering its evidence or admission status.

- All 1,680 sealed terminal and sidecar files matched their recorded sizes and SHA-256 digests. Rollout ZIP member digests and native transport archive checks were verified. Partial recording and archive integrity metadata remain unchanged.
- All 108 observed requests have a native association. Each of 107 completed requests has matching body, protocol, input, output, total and cache-read usage. The cancelled title request has a unique body association and unknown usage. There are no new association ambiguities, missing native requests or unconfirmed dispatches; recorded coverage remains 1.0 for every preflight.
- All 108 retained upstream bodies, including helpers, use `bailian/deepseek-v4.1-flash`, `enable_thinking: false`, temperature 1 and `max_tokens: 393216`, with no reasoning tier or developer role. The frozen plan retains context 1,000,000, `synergy-max`/full, Linux amd64, JIT enabled, concurrency/repeat 1 and seed 20260921. Solving and verification each remain 10,800 seconds; doctor is 600 seconds.
- Every executed preflight contains the actual shell marker in a subsequent tool-result message sent to the provider. This does not override the failed cleanup admission.
- The historical v5 final ledger and refusal digests remain unchanged, including three candidate dasel association ambiguities. No scores, original coverage or failed controls were rewritten.

## All 24 planned pairs

The table follows frozen pair order. “Missing” means no formal execution, reward or native task-test result exists on that side. Formal input/output/cache usage, solving wall time and paired deltas are likewise unavailable for every row. Zero new formal requests were observed; that is an absence of execution, not an estimate of a task's required tokens.

| Task                                                 | Baseline preflight | Candidate preflight     | Baseline formal reward | Candidate formal reward |
| ---------------------------------------------------- | ------------------ | ----------------------- | ---------------------- | ----------------------- |
| terminal-bench-2.1/polyglot-c-py                     | Passed             | Passed                  | Missing                | Missing                 |
| deepswe-1.1/drizzle-orm-window-function-builders     | Passed             | Passed                  | Missing                | Missing                 |
| terminal-bench-2.1/make-doom-for-mips                | Passed             | Passed                  | Missing                | Missing                 |
| deepswe-1.1/superjson-error-stack-serialization      | Passed             | Passed                  | Missing                | Missing                 |
| deepswe-1.1/bandit-incremental-cache-control         | Passed             | Passed                  | Missing                | Missing                 |
| deepswe-1.1/mobly-grouped-test-barriers              | Passed             | Passed                  | Missing                | Missing                 |
| deepswe-1.1/sqlfmt-create-table-ddl-formatting       | Passed             | Passed                  | Missing                | Missing                 |
| terminal-bench-2.1/compile-compcert                  | Passed             | Passed                  | Missing                | Missing                 |
| terminal-bench-2.1/adaptive-rejection-sampler        | Passed             | Passed                  | Missing                | Missing                 |
| deepswe-1.1/fd-deterministic-multi-key-sorting       | Passed             | Passed                  | Missing                | Missing                 |
| terminal-bench-2.1/financial-document-processor      | Passed             | Failed: cleanup timeout | Missing                | Missing                 |
| terminal-bench-2.1/mailman                           | Unstarted          | Unstarted               | Missing                | Missing                 |
| local24-repro-v6/mcmc-sampling-stan                  | Unstarted          | Unstarted               | Missing                | Missing                 |
| terminal-bench-2.1/large-scale-text-editing          | Unstarted          | Unstarted               | Missing                | Missing                 |
| terminal-bench-2.1/feal-linear-cryptanalysis         | Unstarted          | Unstarted               | Missing                | Missing                 |
| terminal-bench-2.1/openssl-selfsigned-cert           | Unstarted          | Unstarted               | Missing                | Missing                 |
| deepswe-1.1/valibot-recursive-schema-composition     | Unstarted          | Unstarted               | Missing                | Missing                 |
| local24-repro-v6/build-cython-ext                    | Unstarted          | Unstarted               | Missing                | Missing                 |
| deepswe-1.1/katex-multicolumn-array-spans            | Unstarted          | Unstarted               | Missing                | Missing                 |
| terminal-bench-2.1/path-tracing-reverse              | Unstarted          | Unstarted               | Missing                | Missing                 |
| deepswe-1.1/dasel-html-document-format               | Unstarted          | Unstarted               | Missing                | Missing                 |
| deepswe-1.1/kcp-go-multiplexed-kcp-streams           | Unstarted          | Unstarted               | Missing                | Missing                 |
| deepswe-1.1/boa-hierarchical-evaluation-cancellation | Unstarted          | Unstarted               | Missing                | Missing                 |
| deepswe-1.1/kgateway-consistent-hash-policy          | Unstarted          | Unstarted               | Missing                | Missing                 |

## Preflight costs and time

These are connectivity checks on the same first 11 task environments per product, not solutions to those tasks. Counts include primary, title, intent and all other observed helper calls. Cache reads are included within input, never added twice. Candidate totals are known lower bounds because one cancelled request lacks usage. The provider did not separately report cache-write or reasoning token usage; those subfields remain unknown rather than measured zeros. No monetary amount is inferred without verified pricing.

| Product   | Preflights | Requests | Known input | Known output | Known cache read (in input) | Known total | Usage-unknown requests | Native wall seconds | Full attempt seconds |
| --------- | ---------: | -------: | ----------: | -----------: | --------------------------: | ----------: | ---------------------: | ------------------: | -------------------: |
| baseline  |         11 |       55 |     839,998 |        1,912 |                     270,720 |     841,910 |                      0 |            1288.120 |             1525.545 |
| candidate |         11 |       53 |     840,417 |        1,796 |                     283,648 |     842,213 |                      1 |            1763.180 |             2106.966 |

Driver interval: 2026-09-22 11:11:50 UTC to 2026-09-22 12:13:26 UTC, 61.599 minutes. Native wall time covers the CLI/observer execution record; full attempt time runs from first recorded preparation stage to the terminal probe record and includes setup/export/cleanup. Neither is formal task-solving time.

All observed preflights are listed below. Values marked with ≥ have incomplete usage; known values are retained without zero-filling.

| Order | Task                                             | Product   | Requests |   Input | Output | Cache read |   Total | Native seconds | Attempt seconds |
| ----: | ------------------------------------------------ | --------- | -------: | ------: | -----: | ---------: | ------: | -------------: | --------------: |
|     1 | terminal-bench-2.1/polyglot-c-py                 | baseline  |        5 |  76,033 |    176 |      1,024 |  76,209 |        111.927 |         125.797 |
|     2 | terminal-bench-2.1/polyglot-c-py                 | candidate |        5 |  79,976 |    177 |     40,448 |  80,153 |         65.965 |          84.296 |
|     3 | deepswe-1.1/drizzle-orm-window-function-builders | candidate |        5 |  73,630 |    158 |      7,680 |  73,788 |         97.527 |         121.890 |
|     4 | deepswe-1.1/drizzle-orm-window-function-builders | baseline  |        5 |  76,552 |    180 |     42,752 |  76,732 |         64.339 |          85.759 |
|     5 | terminal-bench-2.1/make-doom-for-mips            | baseline  |        5 |  76,011 |    177 |     42,752 |  76,188 |         54.563 |          68.812 |
|     6 | terminal-bench-2.1/make-doom-for-mips            | candidate |        5 |  79,961 |    155 |     40,960 |  80,116 |         65.495 |          83.683 |
|     7 | deepswe-1.1/superjson-error-stack-serialization  | candidate |        5 |  73,648 |    170 |     12,416 |  73,818 |         83.985 |         107.732 |
|     8 | deepswe-1.1/superjson-error-stack-serialization  | baseline  |        5 |  76,522 |    170 |     37,760 |  76,692 |        154.282 |         175.491 |
|     9 | deepswe-1.1/bandit-incremental-cache-control     | baseline  |        5 |  76,524 |    166 |      2,816 |  76,690 |        122.920 |         146.356 |
|    10 | deepswe-1.1/bandit-incremental-cache-control     | candidate |        5 |  73,643 |    169 |     10,880 |  73,812 |        121.066 |         145.042 |
|    11 | deepswe-1.1/mobly-grouped-test-barriers          | candidate |        4 |  72,954 |    166 |     70,144 |  73,120 |        174.590 |         198.391 |
|    12 | deepswe-1.1/mobly-grouped-test-barriers          | baseline  |        5 |  76,529 |    162 |     41,984 |  76,691 |         58.403 |         101.866 |
|    13 | deepswe-1.1/sqlfmt-create-table-ddl-formatting   | baseline  |        5 |  76,528 |    168 |     44,288 |  76,696 |         35.008 |          55.957 |
|    14 | deepswe-1.1/sqlfmt-create-table-ddl-formatting   | candidate |        4 |  72,971 |    170 |     41,600 |  73,141 |        166.166 |         189.911 |
|    15 | terminal-bench-2.1/compile-compcert              | candidate |        5 |  80,356 |    153 |      5,120 |  80,509 |        257.609 |         274.300 |
|    16 | terminal-bench-2.1/compile-compcert              | baseline  |        5 |  76,384 |    171 |     38,912 |  76,555 |         87.788 |         113.958 |
|    17 | terminal-bench-2.1/adaptive-rejection-sampler    | baseline  |        5 |  76,395 |    173 |      6,656 |  76,568 |         81.568 |          95.489 |
|    18 | terminal-bench-2.1/adaptive-rejection-sampler    | candidate |        5 |  80,382 |    171 |     10,752 |  80,553 |        230.924 |         249.482 |
|    19 | deepswe-1.1/fd-deterministic-multi-key-sorting   | candidate |        5 |  73,632 |    167 |     40,576 |  73,799 |         63.001 |          85.993 |
|    20 | deepswe-1.1/fd-deterministic-multi-key-sorting   | baseline  |        5 |  76,493 |    160 |      9,472 |  76,653 |        160.997 |         182.129 |
|    21 | terminal-bench-2.1/financial-document-processor  | baseline  |        5 |  76,027 |    209 |      2,304 |  76,236 |        356.325 |         373.931 |
|    22 | terminal-bench-2.1/financial-document-processor  | candidate |        5 | ≥79,264 |   ≥140 |     ≥3,072 | ≥79,404 |        436.852 |         566.246 |

| Cost population                                         | Observed requests | Known tokens (lower bound where incomplete) | Usage-unknown requests | Additional unconfirmed dispatches |
| ------------------------------------------------------- | ----------------: | ------------------------------------------: | ---------------------: | --------------------------------: |
| Historical paid family, unchanged                       |             1,259 |                                 100,551,523 |                     18 |                                 2 |
| New v7 preflights, including failed attempt and helpers |               108 |                                   1,684,123 |                      1 |                                 0 |
| Combined paid family                                    |             1,367 |                                 102,235,646 |                     19 |                                 2 |

| Known token component        | Historical family | New v7 study | Combined family |
| ---------------------------- | ----------------: | -----------: | --------------: |
| Input, including cache reads |       100,294,815 |    1,680,415 |     101,975,230 |
| Output                       |           256,708 |        3,708 |         260,416 |
| Cache read, already in input |        95,951,104 |      554,368 |      96,505,472 |

The failed preflight contributes five requests and at least 79,404 tokens, with one unknown-usage request. No new paid formal or diagnostic execution occurred. Free deterministic/reference controls are retained separately and are not billed provider requests. The combined family includes earlier failed, cancelled, diagnostic, preflight and auxiliary calls. Neither the new candidate total nor the cumulative total is exact. No overall token reduction is established.

## Publication and remaining limits

The study is terminally blocked before scoring. Complete original attempts, their native archives, the frozen evaluator and task inputs, final accounting and the independent audit remain retained privately. Research publication changes neither the measured products nor this run. There was no model retry, resampling, rebase, Ready transition or merge. The PR remains Draft.

At the preparation/report parent head `9e8772a8be76dc8fac8db47379a86442cb97d6b4`, six Oryn plan/run/publish checks passed. They do not establish a full branch CI matrix result. Evaluator [CI 35696063127](https://github.com/SII-Holos/synergy/actions/runs/35696063127) retains the external DeepSeek CLI npm dependency failure for `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`. That CLI is separate from this study's Synergy model path and from the Docker cleanup stop. It remains a PR readiness blocker. GitHub also reports merge conflicts, deferred to the user's merge-stage decision.

A new paid study requires an explicit decision after investigation of teardown reliability. The next useful validation is a disposable, no-provider same-image teardown control with scoped daemon events and per-phase timing, covering logs/ownership handoff as well as container stop. A later success must not replace this failure. The cause of slow shutdown, complete task-quality comparison, formal token differences, latest full branch CI and merge integration remain unresolved.

This report contains the full declared population and all observed costs but cannot supply the requested 48 formal results. The [historical paired results](2026-09-21-boyue-coding-observations.md) remain separate and do not fill these missing cells.

## Evidence identity

The audit and cost ledger are private derived artifacts; public prose contains no credentials, private endpoints, native session IDs or local runtime paths. Digest references identify the retained artifacts without publishing their contents.

- Frozen plan: `a5b581efd3c086b0b3575a0c1539a0d47b0ac101436b0fbcdca4f8f379582191`.
- Evaluator Python: `b69016eb308334c4b6b3c7859a893cf6b15f5fbfc3ae018f1d703932a861f20d`.
- Evaluator runtime: `377e08b5a52a29bcb735de49b8e618b3c928d2df6928756bb54ee3c8803886d1`.
- Independent final audit: `e00c473b8e8fd1b96a47c2b25018552a579d0551c19be43f029f9496338589ab`.
- Final v7 accounting: `92123a0894093b25d3c435b8fbac739bfeee7662defa731029d64c1e561b8b2f`.
- Scoped retained Docker events: `65f40a943f2d5a8ffde68759f57a4400012e67b68ee8653a6b6586ce4de5a267`.
- Historical final ledger: `729f91121294662a19768667bda050e79e71000c6fe8ff221e8895f8f9178851`.
- Historical final refusal: `11b259ee56d4d97e3761fccaeeb8a3da4b95632554ae698f793867147d61cda2`.
