---
name: develop-benchmark
description: Change or validate the repository benchmark evaluator, native harness integrations, model protocols, accounting, scheduling, cache ownership, oracle audits, and comparative reports. Use for benchmark implementation and research infrastructure, not product prompt optimization.
---

# Develop the Benchmark Evaluator

## Freeze the experiment

1. Read [benchmark ownership](../../../benchmark/AGENTS.md), [commands and formats](../../../benchmark/README.md), and the [matrix decision](../../../docs/decisions/implemented/architecture/2026-09-14-benchmark-native-harness-matrix.md).
2. Separate evaluator code, measured harness source or package version, runtime composition, model profile, native task inputs and repeat identity. Declare configuration differences as named variants before observing scores.
3. Freeze a new experiment after changing the evaluator. Resume only through the recorded evaluator. Import historical evidence into reports without rewriting attempts or continuing old runs under new execution code.
4. Keep provider keys in environment references. Exercise the actual container, native harness, inference proxy, observer and streaming recorder before admitting paid tasks. A direct model probe is insufficient.

For full-product research, record the composition's registered tools, all agent identities and the primary agent's normal delegation catalog before execution. Keep host-selected private agents distinct from model-selectable children; preserve native permission and deferred-tool behavior. Verify live availability separately from registration, including platform, network, provider protocol and fresh-install credential requirements. Declare an independent `probe_timeout_seconds` when a native tool roundtrip needs more time than the default probe; never borrow the formal solving deadline silently.

## Preserve execution and evidence

1. Write a failing behavioral regression before changing lifecycle, protocol, usage or scoring behavior. Use the native verifier and its deadlines. Preparation, execution, export and cleanup have separate deadlines.
   Preserve Pier's `AgentTimeoutError` when an outer deadline interrupts execution; its native exception type determines whether artifact collection and verification continue. Validate this with a real timed-out native oracle and a completed verifier.
2. Keep native prompts, tools, loops and compaction. A protocol bridge converts messages and streams; it must not create an agent loop or silently drop unsupported controls.
3. Exercise both Git and ordinary workspaces when upgrading native CLIs. Wait for the CLI's terminal process and native session state; a completed model turn does not establish that the agent loop ended.
   For a native stall, compare the actual CLI with and without the observer in disposable environments before attributing it to capture. Runtime controls such as OpenCode's `bun_jit` require explicit named variants, retained effective settings and actual CLI acceptance; never hot-switch the original attempt. A passing workaround does not by itself establish the stalled process's internal root cause.

   Repeat native long-session controls and inspect thread waits when the CLI stops progressing; compare container-local and mounted Home storage before attributing a wait inside capture to filesystem failure. Keep diagnostic no-progress limits separate from task deadlines. Use an explicit extended-deadline research configuration when tasks need more solving time, verify the effective deadline at every harness launch and preserve native verifier limits. Operator cancellation retains first-attempt scoring and all costs but excludes that execution from paired differences.

   Match the native launch environment, including its complete `PATH`, and verify that a control exercised the intended operation; a trailing marker or successful shell exit can mask a missing service command. For daemon-start stalls, retain native tool state and inspect inherited stdout/stderr descriptors in disposable controls. Compare inherited streams with explicitly redirected streams before attributing the wait to the observer or storage. Keep invalid controls and their costs, and never apply a diagnostic command change to a frozen task prompt or active candidate.

4. Persist request intent before dispatch and terminal evidence before scheduler state. Reconcile retained terminal records before resuming. A new paid attempt needs its own retained reason; never replace failed attempts or select the best score retrospectively.
   Automatic native startup retries require positive evidence that no model request started, an entirely empty ledger, completed archiving and clean teardown. Keep the three-attempt task budget durable across recovery, test ambiguous/torn ledger rejection, and preserve each failed attempt and recorded backoff. On Linux, recover container-owned private log ownership before reading native terminal records or removing orphaned containers. Preserve file bytes and modes; test both running and stopped containers.
5. Cross-check every completed provider request against native evidence. Interrupted requests retain unknown usage and any known lower bound. Cache and reasoning tokens have explicit inclusion rules; byte measurements remain bytes.
6. Read the primary native reward while preserving auxiliary verifier metrics. Require positive test-start evidence separately. Check archive contents and checksums independently of agent outcomes and rewards.

   When a native verifier fails after the program already generated output, inspect stale files, retained background processes and the verifier's readiness condition. Compare the same retained candidate in disposable environments before retrying the model. Preserve original reward and classify unresolved verifier failures separately. If the original artifact was not retained, label reconstruction from native write/edit records explicitly; matching compiler versions or file sizes do not prove byte identity. Never use oracle code to repair the candidate.

   Apply [verified task patches](../../../benchmark/patches/README.md) only to a new task copy after checking the pinned source hash. Verify the resulting hash and native assertions under the reproducing condition, then freeze a separately named corrected experiment. Do not patch shared dataset caches, active inputs or original results. Record resource differences and every diagnostic/recovery cost.

   Respect the environment's declared log mounts when delivering instructions: a host file in a mounted log directory is already visible at its container path. Upload it only for non-mounted environments; keep credentials in separate private temporary files. Test both paths with real file contents and retain pre-dispatch transfer failures without calling them model failures.

## Control resources and cache ownership

1. Inspect Docker quotas, host pressure and native task/verifier declarations. Use shared resource reservations for concurrent evaluators using the same cache. Keep reserved resources and admission decisions in evidence; do not kill running tasks to make room.
   Deduplicate kernel OOM observations by container identity and nanosecond event time, independently of CLI/API serialization metadata. Validate resource parsers against a real container: Docker process inspection requires a PID column alongside RSS. Preserve unknown metrics when inspection fails, and distinguish sampled peaks from kernel maxima.
2. Reuse immutable artifacts and downloads. Verify frozen artifacts before use, protect explicit inputs before collection, and publish receipts atomically. Never claim pre-existing shared images or invoke global Docker prune.
3. Validate cold and warm preparation, simultaneous builders, interrupted publication and damaged cache entries. A warm run must not reinstall a fixed native package or contact a registry to re-check its version.
4. Audit every selected task with its isolated native oracle. Retain failures and their evidence in the full task inventory. Use `oracle-report` to import retained scores without executing the oracle again.

## Verify and publish

1. Run the narrow Python/Bun regression, relevant pure suites and static checks. Root-invoked mypy must explicitly select `benchmark/pyproject.toml`; `uv --project` selects the environment but does not change mypy's configuration discovery directory. For wire changes run `test_gateway.py`, `test_gateway_faults.py` and the native capture tests.
2. Run the native Docker matrix with two deterministic models over both protocols. Keep live credentials out of CI. Actual CLIs, restricted inference egress and real tool roundtrips are required.
   Exercise native compaction with actual retained tool history as well as reported usage; a high synthetic token count alone may not leave any eligible history to summarize. Require a native compaction record and per-request usage reconciliation. Use the shared CI evidence collector for lifecycle and native matrix jobs; never recurse into native homes or follow symlinks when publishing diagnostics. Native `rollout.tar.gz` includes the private Home and stays local; collect its validation/checksum metadata instead. Synergy `rollout.zip` follows the public rollout contract.
3. Verify deadline propagation across every subprocess and Docker layer before live acceptance: an unspecified native execution deadline inherits its caller, while preparation defaults stay scoped to preparation. Test work that exceeds the preparation ceiling, explicit execution deadlines and cancellation cleanup. Retain failure types and cause locations without exception text or locals; integration probes must fail immediately when their evaluator exits before dispatch. Run live acceptance from frozen inputs. Count all attempts, preflights and diagnostic runs in family reports. Model failures are observations; unexplained evaluator failures block claims of support.
4. Compare only matching model/task/repeat/conditions. Expose missing or unpairable samples. Use seeded task-cluster bootstrap and only produce precise token differences for reconciled complete usage.
5. Update this workflow, package documentation and an implemented decision record when their behavior changes. Run skill, documentation, decision, test-layout and workspace-boundary gates; follow `git-guide` for publication.

## Runtime cache boundaries

Synergy's prepared runtime key covers TypeScript sources and the shared `deadline.mjs`; external CLIs use separate Node bundles keyed by every file in `engines.NATIVE_RUNTIME`. Adding an executed dependency requires updating its owning key and invalidation regression. Frozen bundles still verify their complete recorded bytes; external CLI observers copied into a Synergy bundle are not executed by Synergy.
