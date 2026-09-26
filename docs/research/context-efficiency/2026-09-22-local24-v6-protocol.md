# Local-24 paired study v6

The user authorized the full paired study after the benchmark repairs were committed. This protocol defines the prospective study following the [infrastructure audit](2026-09-22-local24-infrastructure-audit.md). Its new execution identity is local24-v7; the dependency task revision remains v6. It does not resume v5, replace its failed admission or reinterpret its scores. Model quality failures remain in the sample; infrastructure and evidence failures stop further dispatch.

## Frozen comparison

| Condition         | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Baseline          | v3.0.22, `024dd683e091d9fce3d1d26b79b2e188ce636b52`                                  |
| Candidate product | `ecf1426a47bf8bbd13b13bd9c47d28b39bdeff05`                                           |
| Provider/model    | Boyue `bailian/deepseek-v4.1-flash`                                                  |
| Thinking          | `enable_thinking: false`; no reasoning tier                                          |
| Limits            | Context 1,000,000; output 393,216                                                    |
| Sampling          | Temperature 1; one execution per task and product                                    |
| Runtime           | `synergy-max`, `full`, Linux amd64, JIT enabled                                      |
| Scheduling        | Concurrency 1; seed 20260921; exactly 48 planned formal cells                        |
| Deadlines         | Solving, oracle execution and verification each 10800 seconds; preflight 600 seconds |
| Admission         | `strict-synergy-v1`                                                                  |

Evaluator and documentation commits do not change the measured candidate. Neither product follows subsequent development commits. The prepared plan freezes the evaluator, source artifacts, complete task order, task digests, resolved images, resources and private provider configuration before model execution.

## Task population and readiness

The [frozen derivative suite](../../../benchmark/suites/local-24-repro-v6.json) retains all 24 selections from [local-24](../../../benchmark/suites/local-24.json): 12 DeepSWE and 12 Terminal-Bench tasks. Twenty-two task payloads remain unchanged. The Cython and Stan tasks use explicitly versioned dependency/reference repairs, with the original instructions, verifier assertions, resources preserved; execution uses the fixed three-hour policy. The task provenance maps each derivative to its original digest and enumerates changes. Scores for these two derivatives are not scores for the unmodified upstream tasks or an official benchmark leaderboard.

Readiness requires native reference validation for every task, independent evidence validation, and actual tool execution by both frozen products. Prior reference controls are reusable only for identical task content, with their original evaluator identity and limitations retained. New dependency layers require new reference controls, recorded actual image identities and tool-visible cache/configuration checks. A failed reference, failed image build or incomplete preflight remains retained and cannot be replaced by a later success under the same identity.

The final task suite and readiness inventory must be committed before paid dispatch. Reference solutions run only in isolated oracle environments. Model attempts start from fresh task state and never receive reference output.

The run performs one real-provider doctor for each frozen task/product cell before formal execution. These 48 tool checks are preflights, separate from the 48 scored cells, and their helper requests and costs remain in the ledger. The free prerequisites reuse independently revalidated controls for identical inputs, add final-image references for the two derivatives, and exercise both products with two deterministic models on those tasks and bandit. The earlier bandit cleanup failure remains a failed historical observation.

## Dispatch and scoring

Each formal cell executes once in the frozen order. A native zero reward continues the schedule when execution, grading and evidence are valid. A solving timeout also remains a scored observation when the verifier completes and its tests actually start. There is no quality-based early stopping, reordering, best-of selection or replacement sample.

The [admission policy](../../decisions/archived/architecture/2026-09-22-benchmark-serial-admission.md) stops subsequent formal and preflight dispatch when infrastructure, grading, archive or request evidence fails. The failed attempt is persisted before the stop. Recovery rechecks it instead of launching a replacement. Bounded pre-model startup retries require positive proof of zero requests, complete evidence and clean teardown. An interrupted or partially completed study is reported with its missing cells and costs; it is not labeled a completed 48-cell study.

Reports retain native binary rewards, available test counts, execution outcome, grading status, request coverage and usage uncertainty as separate fields. The first formal result remains the scoring selection. Any operator cancellation is excluded from paired differences and retained in the full inventory and cost ledger.

## Cost and interpretation

Every completed observed request must match independent native identity, body and core usage. Identical bodies cannot identify distinct requests without unique evidence. Interrupted requests and archive-proven empty cancellations retain unknown usage and original coverage. Known token totals are lower bounds when any request or dispatch remains uncertain.

The study reports input, output, cache reads, known total tokens, wall time and native quality for each pair. It includes helper, preflight, diagnostic and failed-call costs, while separating free deterministic-provider controls from real provider usage. Prior studies remain a distinct historical cost population; their incomplete costs cannot become an exact total. Token counts alone do not imply monetary cost without a verified pricing and cache policy.

With 24 tasks and one repetition, the result supports a broader descriptive comparison than the three-task pilot. It does not by itself establish statistical non-inferiority, a general task success rate or a guaranteed efficiency improvement. Final delivery includes all pairs, missing evidence, failed controls and CI status. The PR remains Draft until acceptance is resolved; merging remains a user decision.
