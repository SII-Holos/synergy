---
name: develop-benchmark
description: Change or validate the repository benchmark evaluator, native harness integrations, model protocols, accounting, scheduling, cache ownership, oracle audits, and comparative reports. Use for benchmark implementation and research infrastructure, not product prompt optimization.
---

# Develop the Benchmark Evaluator

## Freeze the experiment

1. Read [benchmark ownership](../../../benchmark/AGENTS.md), [commands and formats](../../../benchmark/README.md), and the [matrix decision](../../../docs/decisions/implemented/architecture/2026-09-14-benchmark-native-harness-matrix.md).
2. Separate evaluator code, measured harness source or package version, runtime composition, model profile, native task inputs and repeat identity. Declare configuration differences as named variants before observing scores.
   A model profile that enables thinking must also declare its reasoning tier. Providers expose depth through a separate control from the enable switch, so an omitted tier silently inherits the provider default and the retained evidence cannot state the condition that produced a score. Name the tier in the model key and set it explicitly; treat a different tier as a new named condition rather than a reinterpretation of a completed run. See the [tier decision](../../../docs/decisions/implemented/architecture/2026-09-20-benchmark-explicit-reasoning-tier.md).
3. Freeze a new experiment after changing the evaluator. Resume only through the recorded evaluator. Import historical evidence into reports without rewriting attempts or continuing old runs under new execution code.
4. Put disposable live-task workspaces outside protected assistant configuration directories. Validate that the actual sandbox can run a fixture-local Node/Bun test before interpreting model recovery loops as harness regressions. A fixture inside a denied ancestor can permit some reads while breaking module resolution and current-directory discovery.
5. Keep provider keys in environment references. Exercise the actual container, native harness, inference proxy, observer and streaming recorder before admitting paid tasks. A direct model probe is insufficient.

## Preserve execution and evidence

1. Write a failing behavioral regression before changing lifecycle, protocol, usage or scoring behavior. Use the native verifier and its deadlines. Preparation, execution, export and cleanup have separate deadlines.
   Preserve Pier's `AgentTimeoutError` when an outer deadline interrupts execution; its native exception type determines whether artifact collection and verification continue. Validate this with a real timed-out native oracle and a completed verifier.
2. Keep native prompts, tools, loops and compaction. A protocol bridge converts messages and streams; it must not create an agent loop or silently drop unsupported controls.
3. Exercise both Git and ordinary workspaces when upgrading native CLIs. Wait for the CLI's terminal process and native session state; a completed model turn does not establish that the agent loop ended.
   For a native stall, compare the actual CLI with and without the observer in disposable environments before attributing it to capture. Runtime controls such as Synergy/OpenCode `bun_jit` require explicit named variants, retained effective settings and actual CLI acceptance; never hot-switch the original attempt. A passing workaround does not by itself establish the stalled process's internal root cause.

   For Bun controls, check the effective environment of the actual native CLI process (Synergy intentionally sanitizes the shell tool environment) and complete at least 120 tool roundtrips with two deterministic models; a short doctor probe cannot establish long-session stability. Match the intended workload's observation sizes, allocation pressure and tool mix: repeated tiny shell outputs can pass while real file-reading sessions still stall.

   Repeat native long-session controls and inspect thread waits when the CLI stops progressing; compare container-local and mounted Home storage before attributing a wait inside capture to filesystem failure. Keep diagnostic no-progress limits separate from task deadlines. New research YAML inherits the central solving deadline; native task timing requires explicit `timeout_seconds: native`, and numeric overrides declare a different condition. Never copy default deadlines between presets. Keep every preset in automatic discovery tests, verify the frozen configuration and effective deadline at every harness launch, and preserve native verifier limits. The outer clock owns solving from first dispatch; nested CLI deadlines must include startup and cleanup headroom. Gateway read-idle limits are optional, explicit experiment conditions. Operator cancellation retains first-attempt scoring and all costs but excludes that execution from paired differences.

4. Persist request intent before dispatch and terminal evidence before scheduler state. Reconcile retained terminal records before resuming. A new paid attempt needs its own retained reason; never replace failed attempts or select the best score retrospectively.
   Automatic native startup retries require positive evidence that no model request started, an entirely empty ledger, completed archiving and clean teardown. Keep the three-attempt task budget durable across recovery, test ambiguous/torn ledger rejection, and preserve each failed attempt and recorded backoff. On Linux, recover container-owned private log ownership before reading native terminal records or removing orphaned containers. Preserve file bytes and modes; test both running and stopped containers.
5. Cross-check every completed provider request against native evidence. Interrupted requests retain unknown usage and any known lower bound. Cache and reasoning tokens have explicit inclusion rules; byte measurements remain bytes.
6. Read the primary native reward while preserving auxiliary verifier metrics. Require positive test-start evidence separately. Check archive contents and checksums independently of agent outcomes and rewards.

   Respect the environment's declared log mounts when delivering instructions: a host file in a mounted log directory is already visible at its container path. Upload it only for non-mounted environments; keep credentials in separate private temporary files. Test both paths with real file contents and retain pre-dispatch transfer failures without calling them model failures.

## Control resources and cache ownership

1. Inspect Docker quotas, host pressure and native task/verifier declarations. Use shared resource reservations for concurrent evaluators using the same cache. Keep reserved resources and admission decisions in evidence; do not kill running tasks to make room.
   Deduplicate kernel OOM observations by container identity and nanosecond event time, independently of CLI/API serialization metadata. Validate resource parsers against a real container: Docker process inspection requires a PID column alongside RSS. Preserve unknown metrics when inspection fails, and distinguish sampled peaks from kernel maxima.
2. Reuse immutable artifacts and downloads. Verify frozen artifacts before use, protect explicit inputs before collection, and publish receipts atomically. Never claim pre-existing shared images or invoke global Docker prune.
   Exercise independent cache roots on the same Docker daemon. Task and inference-proxy image identities must isolate ownership by resolved cache root while preserving warm reuse through path aliases; do not fabricate receipts for another cache's images.
3. Validate cold and warm preparation, simultaneous builders, interrupted publication and damaged cache entries. A warm run must not reinstall a fixed native package or contact a registry to re-check its version.
4. Audit every selected task with its isolated native oracle. Retain failures and their evidence in the full task inventory. Use `oracle-report` to import retained scores without executing the oracle again.

## Verify and publish

1. Run the narrow Python/Bun regression, relevant pure suites and static checks. Root-invoked mypy must explicitly select `benchmark/pyproject.toml`; `uv --project` selects the environment but does not change mypy's configuration discovery directory. For wire changes run `test_gateway.py`, `test_gateway_faults.py` and the native capture tests.
2. Run the native Docker matrix with two deterministic models over both protocols. Keep live credentials out of CI. Actual CLIs, restricted inference egress and real tool roundtrips are required.
   Fault-injection fixtures that rely on task expiry must explicitly select `timeout_seconds: native` or their own short deadline. They must not inherit the research solving default; retain the existing terminal-evidence and cleanup assertions.

   Exercise native compaction with actual retained tool history as well as reported usage; a high synthetic token count alone may not leave any eligible history to summarize. Require a native compaction record and per-request usage reconciliation. Use the shared CI evidence collector for lifecycle and native matrix jobs; never recurse into native homes or follow symlinks when publishing diagnostics. The result file inventory must also prune the private runtime Home before traversal, including credential stores created by the measured runtime; keep it available only for local recovery. Native `rollout.tar.gz` includes the private Home and stays local; collect its validation/checksum metadata instead. Synergy `rollout.zip` follows the public rollout contract.

3. Verify deadline propagation across every subprocess and Docker layer before live acceptance: an unspecified native execution deadline inherits its caller, while preparation defaults stay scoped to preparation. Test work that exceeds the preparation ceiling, explicit execution deadlines and cancellation cleanup. Retain failure types and cause locations without exception text or locals; integration probes must fail immediately when their evaluator exits before dispatch. Run live acceptance from frozen inputs. Count all attempts, preflights and diagnostic runs in family reports. Model failures are observations; unexplained evaluator failures block claims of support.
4. Compare only matching model/task/repeat/conditions. Expose missing or unpairable samples. Use seeded task-cluster bootstrap and only produce precise token differences for reconciled complete usage.
5. Update this workflow, package documentation and an implemented decision record when their behavior changes. Run skill, documentation, decision, test-layout and workspace-boundary gates; follow `git-guide` for publication.

## Diagnose retained trajectories

1. Use the offline `synergy_bench.trajectory` module documented in [benchmark ownership](../../../benchmark/README.md#离线轨迹诊断). Keep derived files outside the evidence tree and preserve the original evaluator and scores.
2. Separate trial and preflight latency distributions. Count each retry and child/auxiliary dispatch; retain interrupted HTTP 200 requests without usage as unknown, independently of rate-limit responses. Missing wire records cannot establish zero consumption. Apply missing terminal/wire evidence to grouped totals as well as overall totals; retain known lower bounds in both.
3. Measure prompt regions and repeated tool results in bytes unless the actual provider supplies token attribution. Exact content repetition or unchanged history does not prove removable work or a provider cache hit. Keep request-body duplicate association explicitly weaker than a unique match.
4. Use interval unions for parallel model/tool time. Do not add nested spans, streaming checkpoints, or repeated telemetry gauges as independent work. Native token metrics may use different cache inclusion rules from wire usage.
5. Separate observed quota debits from estimates under dated public plan coefficients. Do not infer the user's plan generation from the API endpoint or equate a subscription unit with one model call. Read failing native test details before attributing unsuccessful tasks to runtime overhead.

## Runtime cache boundaries

Synergy's prepared runtime key covers TypeScript sources and the shared `deadline.mjs`; external CLIs use separate Node bundles keyed by every file in `engines.NATIVE_RUNTIME`. Adding an executed dependency requires updating its owning key and invalidation regression. Frozen bundles still verify their complete recorded bytes; external CLI observers copied into a Synergy bundle are not executed by Synergy.

## Secret detector experiments

Use the [secret-detection package](../../../packages/secret-detection/README.md) for offline span quality and detector timing, and the Harness `benchmark:secrets` command for isolated capture costs. Keep corpus labels independent of predictions; never pass gold spans to adapters. Report incomplete scans and failures separately, retain failed positives in recall denominators, and use completed negatives for false-positive rates. Freeze corpus, detector/model/configuration identity and evaluator source before comparisons. Split future training and holdout by source/template and credential family. Keep real credentials and private transcripts out of fixtures and reports; record timing, counts and sanitized failure codes instead of matched values. These microbenchmarks do not establish task-level or user-visible latency improvements.

离线 wire 诊断必须测试非流式 JSON、错误正文、缺失响应与畸形 SSE。未识别的 framing 不得生成看似精确的零值内容指标；CLI 与导出层应使用一致的证据目录保护规则。
