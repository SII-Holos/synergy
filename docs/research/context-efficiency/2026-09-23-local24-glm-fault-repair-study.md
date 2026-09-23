# Local-24 GLM fault repair: final targeted re-evaluation

This reference records the completed, authorized seven-cell repair study and the resulting 24-pair view on 2026-09-23. The final selected observations are **baseline 15/24 (62.50%) and candidate 14/24 (58.33%)**. Nine tasks pass on both sides, six pass only on the baseline, five only on the candidate, and four have native reward zero on both sides. These observations do not establish an overall quality or efficiency improvement for the candidate.

The seven selected executions finished in **53.381 minutes**: four passed and three had actual functional-test failures. All seven have native scores, executed tests, valid archives, reconciled input/output usage and confirmed resource removal. No new address-pool failure, observer idle-timeout diagnostic, verifier setup failure or native terminal execution error was found in this batch. This is the elapsed time for seven selected cells; it does not establish that a fresh 48-cell matrix can finish within an hour.

The [complete final JSON](2026-09-23-local24-glm-fault-repair-study.json) contains all **76 terminal attempt records**, all 24 pairs, the explicit source-selection rule, stage times, queues, request latency, usage, failures, audit digests and the separate Boa regrade. The [76-row CSV](2026-09-23-local24-glm-fault-repair-study.csv) provides the same attempt population in tabular form and marks the 48 observations selected for the pair view. These are final results, not live progress snapshots. The earlier [69-attempt report](2026-09-23-local24-glm-paired-study.md), its data, and all original evidence remain unchanged.

## Conditions and selection

| Condition                | Frozen value                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Baseline                 | v3.0.22, `024dd683e091d9fce3d1d26b79b2e188ce636b52`                                             |
| Candidate                | `ecf1426a47bf8bbd13b13bd9c47d28b39bdeff05`                                                      |
| V9 evaluator             | `9783be0ab64d1d65b59b3c8c04c35283266f007f`                                                      |
| V10 evaluator            | `96bf64268044fe96db8659067f6900c51ee37967`                                                      |
| V11 evaluator            | `9f85c576e5335077f7c54b19b125fd5ef0d4bdc9`                                                      |
| Provider/model           | Boyue `glm-5.3-flash`; identical auxiliary-role configuration                                   |
| Request settings         | `thinking.type=enabled`, `reasoning_effort=low`, temperature 1, developer role disabled         |
| Context / maximum output | 1,048,576 / 131,072 tokens                                                                      |
| Runtime                  | `synergy-max` / full, native unattended sessions, `question` excluded, JIT enabled, Linux amd64 |
| Suite                    | `local-24-repro-v6`: 22 original payloads plus declared Cython/Stan dependency variants         |
| Scheduling               | `concurrency: auto`, repeat 1, seed 20260921, frozen priority                                   |
| Outer deadlines          | Solving 10,800 seconds; grading 10,800 seconds; queues excluded                                 |
| Entry point              | Repository `bun bench run CONFIG`, formal executions directly, no paid preflight                |

V9 dispatched the original 48 cells. Twenty-one failed for Docker address-pool exhaustion before any model request and retain missing scores. V10 ran exactly those 21 missing cells. V11 selected exactly six affected baseline executions—Doom, Mobly, adaptive rejection sampler, financial documents, FEAL and Valibot—and candidate large-text editing. It did not rerun their healthy counterparts, other ordinary functional failures or the unresolved candidate FEAL worker failure.

For these seven identities, the updated view selects V11 regardless of its new score; for every other identity it retains the prior scored source. No best-of selection is used. Original scores and the 21 null scores remain in the 76-row attempt population. Historical manual-review notes retain their original observation-time wording; the explicit `coverage_view` and this report define the updated comparison.

The products, tasks, model profile, seed and deadlines remained fixed. The evaluator changed, and V11 explicitly routed dependency downloads only for native environments that already allowed internet access. Native no-network environments stayed offline. The [dependency-routing and test-evidence decision](../../decisions/implemented/bug-fix/2026-09-23-benchmark-dependency-routing-and-test-evidence.md), [network-capacity postmortem](../../postmortem/0023-benchmark-network-address-exhaustion.md) and [observer idle-timeout postmortem](../../postmortem/0024-benchmark-session-relay-idle-timeout.md) document the repairs. Calendar time, resource load and dependency routing differ across batches; this is a source-labelled update, not one homogeneous randomized experiment.

## Seven new executions

| Cell | Selected execution                  | Reward | Tests passed / total | Requests | Input + output tokens |
| ---- | ----------------------------------- | ------ | -------------------- | -------- | --------------------- |
| 0000 | baseline Doom/MIPS                  | 1      | 3/3                  | 198      | 12,376,539            |
| 0001 | baseline Mobly                      | 1      | 887/887              | 115      | 6,672,712             |
| 0002 | baseline Adaptive rejection sampler | 0      | 8/9                  | 117      | 3,693,091             |
| 0003 | baseline Financial documents        | 0      | 3/7                  | 141      | 3,047,178             |
| 0004 | candidate Large text editing        | 1      | 5/5                  | 9        | 212,766               |
| 0005 | baseline FEAL                       | 1      | 1/1                  | 43       | 1,944,838             |
| 0006 | baseline Valibot                    | 0      | 212/219              | 185      | 10,858,458            |

The three zero rewards are supported by real test execution. The sampler's `normal_samples.txt` starts with a quoted nonnumeric `sample` header, so `numpy.loadtxt` cannot load it; the other eight tests pass. Financial processing puts documents in the wrong invoice/non-invoice sets and writes ten CSV rows instead of the required eleven, producing four failed assertions. Valibot passes all 209 preservation tests and three of ten new-feature tests; five failures concern unresolved `Recur` placeholders in recursive transformations and two concern recursive `intersect`/`intersectAsync` composition. None of these three new failures is inferred from a transport error or synthesized missing-result rows.

Doom, Mobly and baseline FEAL change from zero to one; candidate large-text editing also changes from zero to one. The new Mobly success does not identify the cause of its original `ECONNRESET`. Baseline sampler, financial processing and Valibot remain zero with demonstrable output or implementation failures after repair.

## All 24 pairs

B/C means baseline/candidate. `v9`, `v10` and `v11` identify the original, network supplement and targeted fault-repair batches. Cell numbers are batch-local. Scores below are native rewards; zero is not automatically a model-solving failure. Test counts are executed outcomes unless explicitly labelled as placeholders or missing.

| Task                       | Selected source B / C | Reward B / C | Actual tests and interpretation                                                                                   |
| -------------------------- | --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Polyglot C/Python          | v9:0000 / v9:0001     | 1 / 0        | B: 1/1. C: no functional tests; agent killed its package installation, leaving dpkg interrupted.                  |
| Drizzle                    | v9:0003 / v10:0000    | 0 / 1        | B: 692/696; four SingleStore named-window/backtick failures. C: 696/696.                                          |
| Doom/MIPS                  | v11:0000 / v9:0005    | 1 / 1        | Both: 3/3. Repaired baseline succeeds.                                                                            |
| SuperJSON                  | v10:0002 / v10:0001   | 0 / 0        | Both: 191/196; AggregateError and stack filtering; four shared failures and one differing cause-handling failure. |
| Bandit                     | v10:0003 / v10:0004   | 1 / 0        | B: 363/363. C: 362/363; cache-stats output label mismatch.                                                        |
| Mobly                      | v11:0001 / v10:0005   | 1 / 1        | Both: 887/887. New baseline success does not identify the old reset cause.                                        |
| SQLFmt                     | v10:0006 / v10:0007   | 0 / 0        | B: 1298/1305. C: 1294/1305; DDL spacing and strings instead of DdlColumn objects.                                 |
| CompCert                   | v9:0015 / v9:0014     | 1 / 1        | Both: 3/3. Original owned OOM events remain: B 8, C 7.                                                            |
| Adaptive rejection sampler | v11:0002 / v9:0017    | 0 / 1        | B: 8/9; quoted sample header prevents numeric file loading. C: 9/9.                                               |
| fd                         | v10:0009 / v10:0008   | 0 / 0        | Both: 151/152; wrong lexical tie-break for numerically equal names with leading zeros.                            |
| Financial documents        | v11:0003 / v9:0021    | 0 / 1        | B: 3/7; wrong document membership and 10 CSV rows instead of 11. C: 7/7.                                          |
| Mailman                    | v9:0023 / v9:0022     | 1 / 1        | Both: 3/3. Candidate had 34 owned OOM events and ultimately passed.                                               |
| Stan dependency variant    | v9:0024 / v9:0025     | 1 / 1        | Both: 6/6.                                                                                                        |
| Large text editing         | v9:0027 / v11:0004    | 1 / 1        | Both: 5/5. Repaired candidate succeeds.                                                                           |
| FEAL                       | v11:0005 / v9:0029    | 1 / 0        | B: 1/1. C: native worker-start failure remains unresolved; missing output, reward 0.                              |
| Self-signed certificate    | v9:0031 / v9:0030     | 1 / 1        | Both: 6/6.                                                                                                        |
| Valibot                    | v11:0006 / v10:0010   | 0 / 1        | B: 212/219; unresolved Recur placeholders and recursive intersect composition. C: 219/219.                        |
| Cython dependency variant  | v9:0035 / v9:0034     | 1 / 0        | B: 11/11. C: 10/11; unavailable numpy.int.                                                                        |
| KaTeX                      | v10:0011 / v10:0012   | 1 / 0        | B: 693/693. C: 691/693; two multicolumn error-marker failures.                                                    |
| Path tracing               | v9:0039 / v9:0038     | 1 / 1        | Both: 3/3. Baseline retains observer diagnostic but no terminal execution error.                                  |
| dasel                      | v10:0013 / v10:0014   | 1 / 1        | Both: 1158/1158.                                                                                                  |
| kcp-go                     | v10:0016 / v10:0015   | 1 / 0        | B: 42/42. C: 15 test starts, 14 passes, native three-minute test-program timeout; 28 synthesized missing results. |
| Boa                        | v10:0017 / v10:0018   | 0 / 1        | Original B: no tests, 24 missing-result placeholders. Separate free regrade: 22/24, reward 0. C: 24/24.           |
| kgateway                   | v10:0020 / v10:0019   | 0 / 0        | Both: 214 P2P passes; related parent/subtest failure. B: golden mismatch. C: cookie value validation.             |

The selected view has 48 native scores and positive functional-test-start evidence for 46 of those executions. Original baseline Boa and candidate Polyglot lack executed functional tests in their selected records. The separate Boa regrade supplies actual tests for the retained patch without replacing its original record. Candidate FEAL remains a native worker-start failure and cannot establish a pure model-solving failure. Baseline path tracing retains the observer diagnostic but passes 3/3 tests, has no terminal execution error and reconciles all 123 requests; it is not classified as a failed execution.

Candidate Polyglot includes an observed agent action killing its package installation, followed by interrupted dpkg and missing verifier tools; it is not presented as an unexplained random infrastructure accident. Candidate kcp-go has 15 observed starts and 14 passes before its native three-minute test-program timeout; 28 failed report entries are synthesized missing results, including 27 tests without observed starts. That program limit is separate from the unchanged three-hour outer grading budget. The two kgateway failure entries are a parent/subtest pair for one scenario, not two independent scenarios.

## Boa: separate dependency-only regrade

The [completed Boa regrade](2026-09-23-boa-dependency-regrade.md) corrects the earlier explanation. The baseline model patch changed `husky-rs` from 0.3.2 to 0.3.3, while the intentionally offline verifier cached only 0.3.2. Supplying the public 0.3.3 crate after checking its checksum allowed the unchanged retained patch and unchanged native tests to run while remaining offline. This is not a generic random DNS failure.

All 24 tests actually ran: **22 passed, two failed, native reward 0**. The failures concern cancelled session jobs still executing and a later child cancellation overriding an earlier parent reason. The regrade took 173.179 seconds wall time, including 159.946 seconds in the verifier, and added **zero model calls and zero model tokens**. Its resources were removed. Original reward zero and the original 24 missing-result placeholders remain sealed; the regrade is a separate declared condition and adds no independent model sample.

## Tokens in the selected 24-pair view

All selected observations have known main input/output usage. Cache reads are included in input tokens; reasoning is included in output tokens. They must not be added again. Cache-write usage is unknown for every selected request; no zero cache-write total is claimed. Main totals below cover the 48 selected observations, not all money spent on this research.

| Selected side | Requests |       Input |    Output | Cache read (input subset) | Reasoning (output subset) | Input + output |
| ------------- | -------: | ----------: | --------: | ------------------------: | ------------------------: | -------------: |
| Baseline      |    3,108 | 175,847,711 | 1,297,162 |               141,237,440 |                   645,118 |    177,144,873 |
| Candidate     |    2,117 | 174,437,020 |   977,403 |               142,988,672 |                   548,397 |    175,414,423 |

Candidate selected input-plus-output consumption is 0.977% lower, with one fewer passed task and different failure paths. That arithmetic is not evidence of an efficiency improvement. On the nine tasks where both selected observations passed, the baseline used 47,567,763 tokens and the candidate 79,427,579, or **66.978% more for the candidate**. This is an outcome-selected subset spanning different conditions, not a controlled efficiency estimate. Neither view isolates the effect of this PR from other differences between the two product revisions.

| Task                       | Input B / C             | Output B / C      | Cache read B / C (input subset) | Input + output B / C    |
| -------------------------- | ----------------------- | ----------------- | ------------------------------- | ----------------------- |
| Polyglot C/Python          | 1,207,180 / 635,965     | 4,347 / 3,066     | 1,067,584 / 584,064             | 1,211,527 / 639,031     |
| Drizzle                    | 23,108,454 / 2,155,842  | 286,748 / 23,093  | 18,406,720 / 1,942,272          | 23,395,202 / 2,178,935  |
| Doom/MIPS                  | 12,315,681 / 20,328,363 | 60,858 / 104,486  | 9,185,728 / 17,406,976          | 12,376,539 / 20,432,849 |
| SuperJSON                  | 1,621,672 / 3,247,190   | 19,965 / 23,341   | 1,227,200 / 3,050,368           | 1,641,637 / 3,270,531   |
| Bandit                     | 6,485,342 / 5,504,586   | 27,590 / 22,786   | 5,488,640 / 5,239,552           | 6,512,932 / 5,527,372   |
| Mobly                      | 6,616,174 / 5,550,172   | 56,538 / 36,316   | 5,312,128 / 5,084,736           | 6,672,712 / 5,586,488   |
| SQLFmt                     | 12,397,983 / 8,154,606  | 65,996 / 46,436   | 10,702,848 / 7,332,480          | 12,463,979 / 8,201,042  |
| CompCert                   | 2,308,484 / 16,309,026  | 7,256 / 16,507    | 1,799,168 / 13,329,920          | 2,315,740 / 16,325,533  |
| Adaptive rejection sampler | 3,657,347 / 1,083,928   | 35,744 / 13,461   | 2,463,296 / 939,136             | 3,693,091 / 1,097,389   |
| fd                         | 8,370,340 / 9,250,758   | 57,747 / 54,418   | 6,586,048 / 8,486,016           | 8,428,087 / 9,305,176   |
| Financial documents        | 3,036,731 / 1,651,778   | 10,447 / 5,065    | 2,263,360 / 1,382,912           | 3,047,178 / 1,656,843   |
| Mailman                    | 1,215,503 / 17,612,370  | 8,326 / 63,960    | 994,240 / 14,629,760            | 1,223,829 / 17,676,330  |
| Stan dependency variant    | 5,490,216 / 2,051,196   | 15,549 / 5,231    | 4,095,168 / 1,446,464           | 5,505,765 / 2,056,427   |
| Large text editing         | 152,356 / 210,678       | 2,018 / 2,088     | 106,816 / 67,968                | 154,374 / 212,766       |
| FEAL                       | 1,887,726 / 955,852     | 57,112 / 19,395   | 1,375,360 / 817,152             | 1,944,838 / 975,247     |
| Self-signed certificate    | 186,105 / 207,504       | 1,005 / 1,442     | 178,176 / 197,184               | 187,110 / 208,946       |
| Valibot                    | 10,775,277 / 9,380,782  | 83,181 / 104,244  | 10,012,544 / 6,256,576          | 10,858,458 / 9,485,026  |
| Cython dependency variant  | 1,822,403 / 1,148,002   | 8,598 / 4,825     | 1,530,752 / 1,040,768           | 1,831,001 / 1,152,827   |
| KaTeX                      | 17,053,773 / 16,750,168 | 58,813 / 46,499   | 13,746,368 / 13,762,752         | 17,112,586 / 16,796,667 |
| Path tracing               | 11,844,480 / 13,224,139 | 290,694 / 232,508 | 8,971,904 / 10,519,104          | 12,135,174 / 13,456,647 |
| dasel                      | 6,964,865 / 3,447,173   | 31,655 / 24,420   | 5,740,096 / 2,901,440           | 6,996,520 / 3,471,593   |
| kcp-go                     | 6,133,021 / 19,344,650  | 22,433 / 51,529   | 4,468,544 / 13,449,600          | 6,155,454 / 19,396,179  |
| Boa                        | 23,000,354 / 9,021,373  | 60,497 / 42,678   | 18,434,240 / 6,590,784          | 23,060,851 / 9,064,051  |
| kgateway                   | 8,196,244 / 7,210,919   | 24,045 / 29,609   | 7,080,512 / 6,530,688           | 8,220,289 / 7,240,528   |

## Full cost population, including failures and history

| Population                            | Observed requests | Known input + output tokens | Missing usage or dispatch evidence                                  |
| ------------------------------------- | ----------------: | --------------------------: | ------------------------------------------------------------------- |
| Sealed history through stopped V7     |             1,367 |                 102,235,646 | 19 requests with unknown usage; two unconfirmed dispatches          |
| User-cancelled V8                     |             1,296 |                  87,870,445 | Seven attempts with incomplete usage; missing-request count unknown |
| GLM speed/parameter diagnostics       |                 4 |                       2,688 | Two rejected calls with unknown usage                               |
| V9 original, every attempt            |             2,385 |                 147,642,463 | Four interrupted requests with unknown usage                        |
| V10 network supplement, every attempt |             2,532 |                 190,115,923 | Observed main usage complete                                        |
| V11 fault repair, every attempt       |               808 |                  38,805,582 | Observed main usage complete                                        |
| Independent Boa regrade               |                 0 |                           0 | No model execution                                                  |
| Complete retained family              |         **8,392** |             **566,672,747** | **Known lower bound, not an exact family total**                    |

V11's 38,805,582 tokens comprise 38,499,614 input and 305,968 output, with 30,680,384 cache-read tokens and 185,853 reasoning tokens as subsets. Cache-write usage is unknown for all 808 requests. Its 808 calls include the native root, child and auxiliary calls observed by the recorder. Failed, interrupted, diagnostic and historical preflight calls remain in the family population even when their execution is not selected for comparison.

The five frozen prior summaries total 7,584 observed requests and 527,867,165 known tokens. Add V11 once to obtain the final family lower bound; do not add overlapping family totals. The checked summary digests are in the JSON. No exact monetary cost is inferred without a billing statement and applicable provider prices. Historical V5 refusal and association ambiguities, stopped V7 and user-cancelled V8 remain unchanged; see the [stopped study](2026-09-22-local24-v7-stopped-study.md) and [historical observations](2026-09-21-boyue-coding-observations.md).

## Time, queues, model response and resources

| Batch                  | Formal attempts | Launcher wall minutes | Peak execution overlap | Peak resource leases | Median / maximum resource queue seconds |
| ---------------------- | --------------: | --------------------: | ---------------------: | -------------------: | --------------------------------------- |
| V9 original            |              48 |               133.294 |                     27 |                   28 | 80.24 / 148.95                          |
| V10 network supplement |              21 |                76.352 |                     15 |                   17 | 45.15 / 2,132.94                        |
| V11 fault repair       |               7 |                53.381 |                      7 |                    7 | 7.73 / 14.96                            |

V11 ran from 13:10:18 to 14:03:41 UTC (21:10:18 to 22:03:41 in UTC+8). Its frozen dispatch order was `0000` through `0006`, each once. It had no waiting cells or active work at finalization. The seven tasks overlapped; they were not solved serially. Their execution-interval union was 2,974.938 seconds, with the rest of launcher wall time including preparation, grading and finalization. The one-hour full-matrix target remains unverified: the seven-cell duration cannot be multiplied or extrapolated into a reliable 48-cell promise.

| V11 cell | Execution minutes | Verifier minutes | Resource queue seconds | Model-request union minutes | Before-first-data union minutes |
| -------- | ----------------- | ---------------- | ---------------------- | --------------------------- | ------------------------------- |
| 0000     | 49.47             | 1.26             | 7.73                   | 36.33                       | 11.15                           |
| 0001     | 25.04             | 0.13             | 14.96                  | 24.38                       | 6.87                            |
| 0002     | 23.36             | 1.12             | 5.75                   | 19.75                       | 5.70                            |
| 0003     | 12.73             | 3.06             | 3.43                   | 10.74                       | 7.01                            |
| 0004     | 2.88              | 0.99             | 1.08                   | 1.57                        | 0.60                            |
| 0005     | 27.46             | 0.32             | 12.71                  | 25.05                       | 2.06                            |
| 0006     | 48.95             | 0.26             | 9.82                   | 42.03                       | 9.61                            |

Model-request and before-first-data columns are interval unions within each cell; requests may overlap with tools or other requests, so these columns are not additive components of wall time. Doom spends 2,179.94 seconds in recorded model-request intervals during its 2,968.19-second wrapper execution; Valibot spends 2,521.99 during 2,937.23 seconds. Resource queues are under 15 seconds per new cell. The long tail in this batch is predominantly inside ongoing task/model interactions rather than waiting for admission. A long model-request interval includes reasoning/output streaming and does not mean the model produced no response for that entire interval.

| V11 recorder metric, 808 requests           | Median seconds | p95 seconds | Maximum seconds |
| ------------------------------------------- | -------------: | ----------: | --------------: |
| Dispatch to first response data             |          2.144 |       6.835 |          65.564 |
| Whole request, including streaming          |          2.992 |      45.693 |         650.190 |
| After first response data until request end |          0.744 |      37.882 |         645.810 |

All 808 requests have observed start, first-data and terminal timestamps. First response data is recorder evidence, not a claim about the first user-visible token. Long streaming requests must not be described as uninterrupted first-byte waits. Different rows' quantiles cannot be subtracted to derive other latency quantiles.

The seven new cells accumulate 0.168 seconds of preparation-stage queue time, 55.152 seconds of agent-stage queues and 0.162 seconds of verifier queues. These are overlapping cell-seconds, not extra experiment wall time. Full stage events and queues are retained in JSON; nested verifier stages must not be double-counted.

V11's 11,988 samples give a peak sampled memory sum of 7,093,776,384 bytes (6.606 GiB) and a peak sampled CPU sum of 4.494 cores. These sums use the latest valid per-cell measurement within five-second buckets and are not exact simultaneous kernel peaks. Shared recorder RSS is tracked once, separately. No owned OOM event was observed in V11 or V10. V9's 49 owned OOM events remain attached to candidate CompCert (7), baseline CompCert (8) and candidate Mailman (34), all of which ultimately passed. They do not establish a host-wide OOM or explain unrelated transport errors.

The following selected-view times retain their source batch. Execution means the product execution wrapper, including its observer where applicable; it excludes separate verifier work. Queue time is separately recorded. Candidate records without a separately measured native-only duration remain null in JSON; wrapper time is not substituted for that missing field.

| Task                       | Execution wrapper minutes B / C | Verifier-stage minutes B / C | Resource queue seconds B / C |
| -------------------------- | ------------------------------- | ---------------------------- | ---------------------------- |
| Polyglot C/Python          | 6.84 / 10.45                    | 47.57 / 0.34                 | 13.12 / 26.46                |
| Drizzle                    | 57.17 / 13.83                   | 0.22 / 0.41                  | 28.27 / 1,407.53             |
| Doom/MIPS                  | 49.47 / 75.37                   | 1.26 / 3.49                  | 7.73 / 36.79                 |
| SuperJSON                  | 10.65 / 16.25                   | 6.68 / 0.22                  | 398.48 / 1,266.73            |
| Bandit                     | 20.90 / 16.78                   | 0.95 / 1.11                  | 1,068.98 / 5.75              |
| Mobly                      | 25.04 / 22.37                   | 0.13 / 0.26                  | 14.96 / 3.05                 |
| SQLFmt                     | 45.73 / 33.43                   | 0.66 / 1.05                  | 10.76 / 45.15                |
| CompCert                   | 48.44 / 48.48                   | 16.55 / 16.75                | 33.10 / 1.09                 |
| Adaptive rejection sampler | 23.36 / 28.82                   | 1.12 / 45.22                 | 5.75 / 22.12                 |
| fd                         | 38.71 / 35.09                   | 0.33 / 0.33                  | 23.57 / 30.96                |
| Financial documents        | 12.73 / 10.93                   | 3.06 / 53.41                 | 3.43 / 4.18                  |
| Mailman                    | 9.78 / 62.40                    | 37.80 / 9.72                 | 19.15 / 63.36                |
| Stan dependency variant    | 47.07 / 32.50                   | 16.41 / 23.59                | 16.11 / 67.34                |
| Large text editing         | 2.33 / 2.88                     | 24.85 / 0.99                 | 10.24 / 1.08                 |
| FEAL                       | 27.46 / 22.54                   | 0.32 / 17.21                 | 12.71 / 83.50                |
| Self-signed certificate    | 1.87 / 4.28                     | 11.85 / 10.77                | 74.17 / 58.13                |
| Valibot                    | 48.95 / 68.64                   | 0.26 / 0.27                  | 9.82 / 34.37                 |
| Cython dependency variant  | 9.29 / 6.68                     | 0.99 / 0.88                  | 48.69 / 86.53                |
| KaTeX                      | 47.57 / 46.63                   | 0.12 / 0.13                  | 39.41 / 20.27                |
| Path tracing               | 124.22 / 83.35                  | 1.43 / 5.13                  | 68.52 / 91.54                |
| dasel                      | 21.85 / 19.58                   | 12.13 / 3.01                 | 784.59 / 152.25              |
| kcp-go                     | 21.89 / 66.86                   | 0.54 / 3.36                  | 1,454.49 / 46.25             |
| Boa                        | 50.22 / 49.18                   | 0.45 / 3.19                  | 13.61 / 25.97                |
| kgateway                   | 26.12 / 27.74                   | 5.36 / 4.04                  | 670.51 / 2,132.94            |

The original verifier-stage outliers remain visible. Baseline Polyglot spends 2,854.20 seconds in grading although pytest reports 0.19 seconds; candidate sampler spends 2,713.31 seconds versus 14.62 seconds of test execution. Retained stages include dependency/interpreter setup, and per-command timestamps are insufficient to assign the whole difference to one download. These observations are not retroactively changed by the V11 proxy configuration.

## Final audit, publication and limits

The V11 audit used its run's frozen evaluator and checked exactly seven unique dispatches against the authorized manifest. It verified **337 native files and 4,897 sidecars**, with no file-hash mismatch. All seven archives were readable. All 808 completed wire requests matched native usage one-to-one, with no raw-response usage discrepancy, frozen request-parameter violation or `question` tool-catalog violation. Main usage is complete for the new batch; unknown historical usage stays missing. Evidence checksums and sanitized audit metadata are included in JSON.

All seven cells completed cleanup. An independent inventory of their exact owned projects and verifier descendants found no residual containers, networks or volumes. The launcher exited zero. Original audits already verified V9 and V10; this publication reads their sealed final dataset rather than replaying or reinterpreting old evaluators. Across all three batches, 76 terminal records are retained, 55 have native scores and readable model archives, and the original 21 pre-model failures keep null scores. Every attempt's resource-removal result remains available.

The fixes were validated before this run with 196 related Python tests (four opt-in skips), a real Docker proxy regression, Ruff, mypy over 34 source files, 17 local quality gates, and the observer's delayed-header/16-second quiet-stream regression (11 Bun tests, 54 assertions). Native dependency-download controls made no model calls. Result publication checks source identities, unchanged prior rows, scores, costs, test-start interpretation, privacy and document formatting; it does not run another experiment. The [benchmark development workflow](../../../.synergy/skill/develop-benchmark/SKILL.md) retains the distinction between actual tests, missing-result placeholders, dependency-only regrading and model reruns.

Remaining limitations are one execution per selected condition, different evaluator/time/load and dependency-routing conditions across batches, original observer diagnostics, the unresolved candidate FEAL worker failure, candidate Polyglot's broken verifier environment, the native kcp-go test-program timeout, incomplete historical usage, and product differences beyond this PR. No confidence interval or causal optimization claim is made for this mixed view. The targeted faults were repaired and their authorized observations delivered; the data does not support accepting the candidate as an overall improvement. PR #1475 stays Draft. Local results are delivered without waiting for hosted CI; merge-time validation remains a separate decision. No further paid run or automatic replay is part of this report.
