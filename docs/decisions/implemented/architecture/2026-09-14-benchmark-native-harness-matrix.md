# Decision Record: Independent benchmark harness and model dimensions

Status: implemented

## Problem

An experiment that couples the model to Synergy configuration cannot measure whether improvements come from the harness or the model. Native CLI summary events also omit some auxiliary requests. Counting only a successful retry conceals the cost of unsuccessful attempts.

A fixed top-level npm version can still resolve newer prerelease dependencies through caret ranges. DeepSeek Harness `0.1.5-rc.1` admitted the later `rc.3` dependency tree, which referenced an unpublished sidebar package version and failed cold preparation before inference. A package pin alone therefore cannot preserve the validated native installation condition.

## Decision

[Configuration v2](../../../../benchmark/src/synergy_bench/config.py) declares native harness variants and model profiles separately. Matrix cells retain independent task and repeat identities. Five [native configurations](../../../../benchmark/src/synergy_bench/harnesses.py) preserve the upstream CLI loop, tools and prompts. Package versions, frozen source, runtime composition and generated configuration are experimental conditions.

The default DeepSeek `0.1.5-rc.1` pin resolves dependencies available by `2026-09-22T05:00:00Z`, the publication window of the preceding successful native matrix. [npm's `before` option](https://docs.npmjs.com/cli/v11/using-npm/config/#before) applies this condition while generating the lockfile; `npm ci` then installs the resulting exact tree. The cutoff applies only to that verified package version, is included in preparation cache identity and the retained receipt, and cannot be inherited by a different explicitly selected version. Changing the cutoff invalidates the prepared bundle; a warm matching bundle remains offline. Existing frozen experiments retain their original evaluator, dependency lock and artifact.

OpenCode variants can explicitly set `bun_jit`; omission preserves the native default, while false sets `BUN_JSC_useJIT=0` in the retained native process configuration. The [Bun option distinction](https://github.com/oven-sh/bun/issues/22901) informs this mapping; it does not establish the cause of every runtime stall. The strict boolean belongs to the harness axis, applies equally to each selected model, and is rejected for unverified harnesses. Actual CLI integration exercises both default and interpreted variants over both model protocols.

The [long-session research preset](../../../../benchmark/configs/glm53-long-session.yaml) explicitly selects interpreted OpenCode. All presets, formal trials and reference audits use the [fixed three-hour execution policy](2026-09-22-benchmark-fixed-three-hour-budget.md) for solving and verification. Preparation, startup and export retain independent budgets. [Preset launch contracts](../../../../benchmark/test/test_experiment_presets.py) verify the fixed budget across every harness; a short connectivity probe does not establish long-session runtime stability.

Provenance: [Native runtime stall investigation](../../../postmortem/0013-short-native-probes-missed-opencode-rosetta-stalls.md).

Local adaptation: the research preset selects the existing interpreted variant explicitly; neither host detection nor a failed attempt can silently change the runtime or the scoring population.

A host [inference gateway](../../../../benchmark/src/synergy_bench/gateway.py) records durable dispatch intent and raw responses for every provider request. Credentials remain on the host; an ephemeral capability authenticates each isolated task. A versioned [protocol bridge](../../../../benchmark/src/synergy_bench/bridge.py) converts Responses and Chat Completions messages, tools and streams without adding an agent loop or context compaction. Unsupported features fail explicitly. Codex's hosted web search is disabled in its native configuration because a Chat Completions endpoint cannot execute that hosted tool.

[Fault contracts](../../../../benchmark/test/test_gateway_faults.py) exercise DNS failure independently of proxy failure and reject provider dispatch when durable intent cannot be written because storage is full. Previously completed request evidence remains intact. The [cache reserve contract](../../../../benchmark/test/test_cache.py) also verifies that insufficient free disk fails after collecting only owned, unreferenced objects; frozen inputs and unrelated files survive.

Dataset fetches disable automatic Git maintenance before registering their byte inventory. Detached maintenance can repack or remove loose objects after fetch returns, racing the cache receipt and invalidating an otherwise fixed revision. Dataset locking cannot stop a detached Git child. The [catalog regression](../../../../benchmark/test/test_catalog.py) exercises real Git fetches, checks that no maintenance writer is spawned, and verifies the resulting task bytes and cache receipt.

Native transport evidence is cross-checked against the gateway. Native CLI extensions install observers after the CLI configures its transport. Repeated installation is idempotent. Synergy retains its public rollout and accounting contracts. Result v3 separates execution, native reward, verifier execution, positive evidence of test startup, archive validity and usage completeness.

The [report](../../../../benchmark/src/synergy_bench/report.py) counts all retained attempts, including preflight calls, while selecting the first model execution for scoring. Unknown usage retains known lower bounds. Paired comparisons require matching model, task, repeat and experimental conditions, expose missing pairs, and use seeded task-cluster bootstrap. Native reward observations receive Wilson intervals; missing rewards produce success bounds rather than invented scores.

Completed request usage is not a finalized attempt total while the attempt lacks terminal evidence. Live and interrupted snapshots retain the observed token lower bound and original per-request unknown count; they cannot assert complete consumption or invent an extra unknown request merely because the lifecycle is unfinished.

Cross-run pairing also requires the same resolved concurrency, experiment seed, Docker quotas, reserved capacity and declared lifecycle/resource policy. These conditions affect contention and deadline behavior even when per-task limits match. Missing policy evidence makes a historical row unpairable; reports do not backfill current defaults into old experiments. Harness variants remain the treatment axis, while transient load observations are reported rather than treated as identical conditions.

Cancelled executions retain their preselected native reward and all attempt costs, but expose `cancelled_execution` as a pairing exclusion. An operator's early termination changes the observed execution opportunity even when the frozen configuration retains its original deadline. Native deadline expiry remains eligible under matching declared conditions; cancellation cannot promote a later successful attempt into the scoring population.

Native startup timeouts may create up to three automatic attempts only when native lifecycle evidence confirms no model execution, the entire request ledger is empty, the archive is complete and cleanup has no reported failure. Each attempt retains its terminal evidence, retry reason and 1/2-second backoff. Task startup budgets survive recovery; a new explicit doctor invocation records its own reason. Possible delivery, incomplete evidence and post-dispatch failures remain outside this path.

Each attempt starts its own queue clock before resource admission. Prior execution and teardown never become the next attempt's queue latency; retry backoff remains a separately retained value.

Instruction delivery follows Pier's declared log-mount capability: mounted logs expose the host instruction directly, while non-mounted environments receive an upload. Recopying the same bound file adds a Docker failure point without improving visibility. Credentials stay outside the mounted logs and retain their separate private transfer. The [transfer postmortem](../../../postmortem/0014-benchmark-recopied-mounted-instructions.md) preserves the observed failure and the limits of its underlying Docker diagnosis.

The native Synergy control exercises 120 tool roundtrips with real Unicode file reads, edits and verification under both JIT modes and protocols. Its deterministic HTTP provider admits the gateway's 128 MiB request limit: the default 1 MiB fixture limit rejected valid long histories before 120 rounds. The [PR CI decision](../testing/2026-09-27-pr-ci-feedback.md) owns the allocation of equivalent model fixtures: the [central CI catalog](../../../../script/ci/catalog.ts) separates ordinary native controls, four-round model semantics and four JIT/protocol long-session tasks. Each long-session task runs one fixture model with an independent CLI completion deadline. Both models retain tool, transport, reward and exact usage checks; the ordinary native matrix also exercises both models together, preserves task Home and native stopping, and verifies unattended inheritance. [Collection checks](../../../../benchmark/test/test_matrix_collection.py) collect the real runner inventory once and verify the invoked scenarios cover every required behavior without duplication. The shared runner retains the frozen Synergy preparation dependency and selects each scenario explicitly. The [native matrix fixture](../../../../benchmark/test/test_matrix_docker.py) owns separate preparation and CLI completion budgets within the enclosing CI job; native research-task deadlines retain the fixed execution policy.

## Alternatives considered

**Share one long-session deadline across both models.** Serial native execution and export can consume the enclosing limit even when each model keeps progressing. Isolating the model controls preserves the complete workload and existing deadlines without making one model's available time depend on the other's cost.

**Run every model through Synergy's loop.** This would compare model behavior but remove the native harness differences the experiment needs to measure.

**Use native CLI final summaries as the only bill.** Helpers, compaction, retries and interrupted streams do not consistently appear in those summaries. Independent request intent and raw response evidence are needed for reconciliation.

**Treat provider compatibility as an agent adapter detail.** A named, versioned bridge makes wire conversions reviewable and keeps them separate from each CLI's execution behavior.

**Score the latest or best attempt.** This changes the effective sampling policy after outcomes are visible and hides failed attempt costs.

**Automatically disable JIT after a native stall or on an emulated host.** This would change execution conditions during an experiment and conceal the cost of the stalled attempt. Explicit named variants retain the original execution and make the new runtime choice reviewable.

**Upgrade the native package or select dependencies again after a preparation failure.** Either action would silently change the declared experiment. A version-bound publication cutoff records the dependency condition before preparation instead of choosing a successful tree retrospectively.

## Consequences

This adds explicit transport and installation maintenance for each pinned upstream release. Unsupported model features remain visible errors. A bridge cannot preserve features that the target protocol cannot represent; its identity and restrictions belong in experimental conditions. Native model failures remain valid benchmark outcomes when execution and recording are intact. Historical runs remain read-only under changed evaluator contracts.

Dependency updates require a new validated installation condition and native Docker acceptance over both protocols. A publication cutoff does not restore removed registry artifacts; those failures remain preparation failures, while retained immutable bundles can still be reused.

Interpreted OpenCode can have different CPU, memory and latency behavior. It is an experimental runtime option, not a general guarantee against native hangs. A diagnostic variant cannot replace a preselected scoring attempt or repair its missing native usage.
