# Local-24 GLM low: original study and authorized network supplement

This is the final reference for the actual observations from the completed original study (V9) and its explicitly authorized network-failure supplement (S/V10). The 24 task/version pairs now have 48 native reward observations: baseline 12/24 and candidate 13/24 rewards of 1. These are descriptive native scores, not evidence of an overall quality or efficiency improvement. Evaluator transport faults, verifier setup failures, different evaluator batches and intervening product changes prevent that conclusion. PR #1475 remains Draft; historical admission failures remain unchanged.

V9 dispatched 48 cells once: 27 reached the model and obtained native rewards (16 one, 11 zero); 21 failed environment startup with no model request and missing scores. The supplement dispatched exactly those 21 missing cells once (9 baseline, 12 candidate), obtaining 9 one and 12 zero rewards. The 69 original/supplemental attempt records remain separate. No completed counterpart was rerun or selected by score.

The [complete JSON](2026-09-23-local24-glm-paired-study.json) contains all 69 attempts, all 24 pairs, source cells, native scores, test findings, input/output/cache/reasoning usage, missing fields, execution and stage timing, queues, resource admission events, actual dispatch order, request timing and evidence digests. The [69-row CSV](2026-09-23-local24-glm-paired-study.csv) provides a compact tabular export. Original missing scores are null, never zero.

## Frozen conditions

| Dimension                | Value                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| Baseline product         | v3.0.22, `024dd683e091d9fce3d1d26b79b2e188ce636b52`                                             |
| Candidate product        | `ecf1426a47bf8bbd13b13bd9c47d28b39bdeff05`                                                      |
| V9 evaluator             | `9783be0ab64d1d65b59b3c8c04c35283266f007f`                                                      |
| Supplement evaluator     | `96bf64268044fe96db8659067f6900c51ee37967`                                                      |
| Model and roles          | Boyue `glm-5.3-flash`; primary and auxiliary roles use the same profile                         |
| Sampling and reasoning   | temperature 1; `thinking.type=enabled`; `reasoning_effort=low`; developer role disabled         |
| Context / maximum output | 1,048,576 / 131,072 tokens                                                                      |
| Runtime                  | `synergy-max` / full; unattended native sessions; `question` excluded; Linux amd64; JIT enabled |
| Suite                    | `local-24-repro-v6`: 22 original payloads plus declared Cython/Stan dependency variants         |
| Scheduling               | `concurrency: auto`; repeat 1; seed 20260921; fixed matrix priority                             |
| Outer deadlines          | solving 10,800 seconds; grading 10,800 seconds; queue time excluded                             |
| Entry point              | repository `bun bench run CONFIG`; direct formal execution; no paid preflight                   |

Both product revisions remained unchanged. The supplement includes network-capacity admission, immediate first-data progress, release-observer idle-timeout removal and exact cell selection. It preserves original task identity and product/model settings, but changes the evaluator and calendar/load conditions. Nine pairs have both sides in the supplement; Drizzle, Mobly and Valibot have only their missing candidate side supplemented. A release-to-candidate comparison also contains product changes beyond this PR, so it cannot isolate the observation change causally.

## All 24 pairs

B/C means baseline/candidate. `1` and `0` are native rewards. A dash in V9 is the retained network-start gap; a dash in S means that side was not selected for supplementation. Counts below describe native reports except where missing/synthesized results are explicitly identified.

| Task                         | V9 B / C | S B / C | Native tests and interpretation                                                                                                         |
| ---------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Polyglot C/Python            | 1 / 0    | — / —   | B: 1/1 test. C: agent killed its package installation; interrupted dpkg/missing tools prevented tests.                                  |
| Drizzle                      | 0 / —    | — / 1   | B: 692 pass, 4 SingleStore named-window/backtick failures. C: 696/696. Different evaluator batches.                                     |
| Doom/MIPS                    | 0 / 1    | — / —   | B: observer timeout plus verifier DNS failure; tests did not start. C: 3/3.                                                             |
| SuperJSON                    | — / —    | 0 / 0   | Both: 191 pass, 5 fail; AggregateError, stack filtering and cause handling. Four failures overlap; the fifth differs.                   |
| Bandit                       | — / —    | 1 / 0   | B: 363/363. C: 362 pass, 1 cache-stats label mismatch.                                                                                  |
| Mobly                        | 0 / —    | — / 1   | B: transport reset, 808 pass/79 fail; exact cause unresolved. C: 887/887.                                                               |
| SQLFmt                       | — / —    | 0 / 0   | B: 1298 pass/7 fail. C: 1294 pass/11 fail. SQL whitespace and strings returned instead of DdlColumn objects.                            |
| CompCert                     | 1 / 1    | — / —   | Both: 3/3; owned OOM events observed during both runs.                                                                                  |
| Adaptive rejection sampler   | 0 / 1    | — / —   | B: observer timeout, missing ars.R, 9 failed tests. C: 9/9.                                                                             |
| fd                           | — / —    | 0 / 0   | Both: 151 pass/1 fail; numeric equality with leading zeros gives the wrong lexical tie-break order.                                     |
| Financial document processor | 0 / 1    | — / —   | B: verifier DNS/download failure, no functional tests. C: 7/7.                                                                          |
| Mailman                      | 1 / 1    | — / —   | Both: 3/3; 34 owned OOM events observed for C.                                                                                          |
| Stan dependency variant      | 1 / 1    | — / —   | Both: 6/6.                                                                                                                              |
| Large text editing           | 1 / 0    | — / —   | B: 5/5. C: verifier DNS failure, no functional tests.                                                                                   |
| FEAL                         | 0 / 0    | — / —   | B: observer timeout. C: native worker could not start after six native attempts; underlying cause unresolved. Missing output in both.   |
| Self-signed certificate      | 1 / 1    | — / —   | Both: 6/6.                                                                                                                              |
| Valibot                      | 0 / —    | — / 1   | B: observer timeout, 209 pass/10 fail. C: 219/219.                                                                                      |
| Cython dependency variant    | 1 / 0    | — / —   | B: 11/11. C: 10 pass/1 fail, missing numpy.int.                                                                                         |
| KaTeX                        | — / —    | 1 / 0   | B: 693/693. C: 691 pass/2 fail, multicolumn error handling.                                                                             |
| Path tracing                 | 1 / 1    | — / —   | Both: 3/3. B also logged an observer timeout but completed with no terminal error.                                                      |
| dasel                        | — / —    | 1 / 1   | Both: 1158/1158.                                                                                                                        |
| kcp-go                       | — / —    | 1 / 0   | B: 42/42. C: 14 passes, then native test-program timeout; 28 missing results are synthesized as failed.                                 |
| Boa                          | — / —    | 0 / 1   | B: verifier DNS failure, 24 synthesized missing results, no functional tests. C: 24/24.                                                 |
| kgateway                     | — / —    | 0 / 0   | Both: 214 P2P passes; one scenario fails with parent/subtest entries. B: merged-policy golden mismatch. C: cookie attribute validation. |

## Failure attribution and missing test results

The original [Docker address-pool exhaustion](../../postmortem/0023-benchmark-network-address-exhaustion.md) affected 21 cells before model execution. Resource admission had budgeted CPU and memory but omitted subnet capacity. The supplement queues on network pressure; no supplemental cell failed for address-pool exhaustion. The original gaps remain in the data.

The [release-observer idle timeout](../../postmortem/0024-benchmark-session-relay-idle-timeout.md) has exact diagnostics in baseline Doom, adaptive rejection sampler, FEAL and Valibot, all with native reward 0. Baseline path tracing also has that diagnostic but completes with reward 1, all three tests passing, no terminal native error and all 123 requests reconciled. A diagnostic is not itself a failed solution. Baseline Mobly has an ECONNRESET without the matching diagnostic; its exact cause remains unresolved. Candidate FEAL has a native worker-start failure after six native attempts, with no observed owned OOM event; those attempts are not evaluator whole-cell retries. The supplement has no observed idle-timeout diagnostic.

Five scored cells did not run functional tests: V9 candidate Polyglot, baseline Doom, baseline financial documents, candidate large-text editing, and supplemental baseline Boa. Polyglot includes an observed agent action killing its package installation, followed by interrupted dpkg and unavailable tools. The other four have verifier DNS/download failures. Preserve their native zeros while separating these chains from demonstrated incorrect solutions. In particular, Boa cannot support a quality advantage for the candidate: its baseline verifier failed to download `husky-rs` before running tests.

The Boa verifier synthesized 24 failed CTRF rows with “missing from report” messages. The frozen evaluator inferred `functional_tests=started` from those rows. Independent raw-output review establishes that no tests ran; the derived data retains both the original field and this explicit correction. Across the two batches, 43 of the 48 scored cells have positive test-start evidence, not the 44 implied by the uncorrected native grading flags.

Candidate kcp-go is a different incomplete-test case. Raw Go events contain 15 starts and 14 passes (12 P2P and 2 F2P). `TestMuxPriorityPreemption` remains active until the native test program reports `test timed out after 3m0s`; 27 other expected tests have no observed start. Its consolidated report marks all 28 missing results failed. The native three-minute test-program timer is a separate task-verifier limit; the outer 10,800-second grading clock did not expire and was not shortened. No regrading or timer change was performed. The kgateway parent/subtest failures are related entries from one scenario, not two independent failing cases.

## Consumption

All primary, helper, child, compaction and failed/interrupted requests observed by the recorder are included. These rows are run-only spending; the table does not add the sealed historical population repeatedly. Candidate requests use complete observed input/output usage, while four original baseline requests are interrupted with unknown usage.

| Population   | Requests | Known input | Known output | Known cache read | Known total | Unknown main usage |
| ------------ | -------: | ----------: | -----------: | ---------------: | ----------: | ------------------ |
| V9 baseline  |    1,488 |  70,201,680 |    1,249,114 |       54,536,768 |  71,450,794 | 4 requests         |
| V9 candidate |      897 |  75,718,682 |      472,987 |       62,777,408 |  76,191,669 | 0 requests         |
| S baseline   |    1,305 |  90,223,594 |      368,741 |       73,474,496 |  90,592,335 | 0 requests         |
| S candidate  |    1,227 |  99,018,219 |      505,369 |       80,627,264 |  99,523,588 | 0 requests         |

Across the two new batches, baseline has 2,793 observed requests and at least 162,043,129 tokens; candidate has 2,124 requests and 175,715,257 observed input-plus-output tokens. Different failure paths and incomplete baseline usage prevent treating these totals as an efficiency effect. For a concrete task example, supplemental SuperJSON uses 1,641,637 baseline tokens and 3,270,531 candidate tokens; both score zero. Supplemental dasel passes both sides with 6,996,520 baseline and 3,471,593 candidate tokens. These are individual observations, not a general improvement claim.

| Cost population                      | Observed requests | Known token lower bound | Remaining uncertainty                                                             |
| ------------------------------------ | ----------------: | ----------------------: | --------------------------------------------------------------------------------- |
| Historical family through stopped V7 |             1,367 |             102,235,646 | 19 requests with unknown usage; two unconfirmed dispatches                        |
| User-cancelled V8                    |             1,296 |              87,870,445 | Seven attempts with incomplete usage; summary does not give unknown request count |
| Existing GLM diagnostic              |                 4 |                   2,688 | Two rejected calls with unknown usage                                             |
| Prior population, counted once       |             2,667 |             190,108,779 | Sealed summaries, not reinterpreted old records                                   |
| V9 original                          |             2,385 |             147,642,463 | Four interrupted requests with unknown usage                                      |
| S network supplement                 |             2,532 |             190,115,923 | All observed input/output usage present                                           |
| Complete retained family             |             7,584 |             527,867,165 | Known lower bound; also two unconfirmed historical dispatches                     |

Cache reads are a subset of input and reasoning is a subset of output; neither is added again. Cache-write tokens were not separately reported on any of the 4,917 new observed requests, so that field remains unknown, not a measured zero. The JSON retains reasoning usage and all field-level unknown counts. No exact family token total or monetary amount is asserted. Historical paid preflights and failed/auxiliary work remain in the sealed prior costs.

## Time, queues and resources

| Measurement                                            | V9 original | S network supplement |
| ------------------------------------------------------ | ----------: | -------------------: |
| Launcher wall time, minutes                            |     133.294 |               76.352 |
| Peak overlapping native execution wrappers             |          27 |                   15 |
| Peak simultaneous resource leases                      |          28 |                   17 |
| Median per-cell resource/cache queue, seconds          |       80.24 |                45.15 |
| Maximum per-cell resource/cache queue, seconds         |      148.95 |              2132.94 |
| Peak sampled memory sum, GiB                           |       22.05 |                16.67 |
| Peak sampled CPU sum, cores                            |        9.92 |                15.12 |
| Owned Docker OOM events                                |          49 |                    0 |
| First response data, median, seconds                   |        4.16 |                 3.49 |
| First response data, p95, seconds                      |        8.44 |                14.25 |
| First response data, maximum, seconds                  |       53.04 |                59.94 |
| Request elapsed, including streaming, median, seconds  |        5.73 |                 6.54 |
| Request elapsed, including streaming, p95, seconds     |       73.61 |                45.14 |
| Request elapsed, including streaming, maximum, seconds |     2424.11 |               603.83 |

V9 ran from 08:32:08 to 10:45:26 UTC; S ran from 10:39:03 to 11:55:24 UTC on 2026-09-23. The calendar span from the first launcher to the final supplemental exit is 203.264 minutes, with overlap. The one-hour full-matrix target was not met. Even the 21-cell supplement takes 76.352 minutes. These durations do not estimate how a fresh fault-free 48-cell run would perform.

Queues are explicit costs: supplemental candidate kgateway waits 2,132.94 seconds across resource stages, and baseline kcp-go waits 1,454.49 seconds. The supplement accumulates 8,401.85 cell-seconds of agent-stage queues and 1,204.74 cell-seconds of verifier queues; these overlap across cells and must not be added to experiment wall time. Preparation/cache queues are separately recorded. The fixed priority sequence was dispatched once without duplicates; actual stage starts differ because of resource pressure and verifier priority, and are retained per cell in the JSON.

Execution time is not purely model generation. V9 baseline path tracing takes 7,451.36 seconds in the native process (7,453.03 seconds including its observer), while supplemental candidate Valibot and kcp-go execution wrappers take 4,118.56 and 4,011.66 seconds. These observations exceed the assumed 30-minute solving time without reaching the outer three-hour limit. Model first-data latency is also distinct from full request duration: long requests already streaming are not continuous first-byte waits. The latency table covers retained recorder intervals, including interrupted original requests, and does not establish uninterrupted downstream delivery during the original observer defect.

Some original verifier stages dominate wall time: baseline Polyglot takes 2,854.20 seconds in its verifier stage although pytest reports 0.19 seconds; candidate sampler takes 2,713.31 versus 14.62 seconds. Retained output contains interpreter/test-runner/package preparation. Without per-command timestamps, the entire gap cannot be assigned to one download or network operation. Per-cell stage spans and queue times are available in the JSON; nested stages and overlapping requests are not additive.

Memory/CPU peaks sum the latest per-cell sample in five-second buckets. They are sampled sums, not exact simultaneous kernel peaks; shared recorder RSS is reported separately, once. Peak resource leases and peak execution overlap come from interval sweeps rather than sample counts. Original OOM observations are deduplicated by owned container and nanosecond event time: candidate CompCert 7, baseline CompCert 8, candidate Mailman 34. All three cells ultimately pass. These events do not identify host OOM or which subprocess was killed, and are not used to explain unrelated socket/worker failures. No owned OOM event was observed in the supplement.

## Evidence audit and remaining limits

Both final audits used their own frozen evaluator, verified all 69 unique dispatches and single attempts, checked the supplement identities against the original 21 evidence digests, and preserved all original scores and gaps. V9 verified 1,680 retained native files plus 14,646 sidecars; S verified 1,390 native files plus 15,339 sidecars. No recorded file-hash mismatch, completed raw-response usage disagreement, frozen request-parameter violation or `question` catalog violation was found. All 48 model-executed cells have readable native archives; the 21 original pre-model failures have no model archive. Native request association was complete for executed cells, while interrupted request usage remains unknown.

All 69 attempts report completed cleanup and resource removal. An independent exact-project inventory found no remaining owned containers, networks or volumes for either run. V9 exits nonzero while retaining its failures; S exits zero with all 21 native rewards recorded. Launcher exit status does not turn setup-generated zeros into valid solving judgments.

The final data preserves failures rather than repairing scores. Residual limits include the original observer interference, five scored cells without executed functional tests, the native kcp-go suite timeout, one repeat per condition, changed evaluator/time/load for supplementation, incomplete historical/original usage and product changes beyond the PR. No further paid execution, regrading, automatic retry, Ready transition or merge follows from this report. Historical V5 refusal, its request-association ambiguities and prior native-review findings remain intact.
