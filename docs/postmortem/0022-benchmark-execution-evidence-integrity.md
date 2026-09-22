# Benchmark environment, scheduling and admission defects

## Executive summary

A release-to-candidate benchmark gave the historical Synergy CLI a different operating-system home from the task image, hiding preinstalled Go dependencies. The candidate adapter preserved the image home. Short tool probes and successful native oracles missed this because neither exercised the adapter's access to a task dependency cache. The audit also found repeated-request ambiguity, interleaved serial dispatch and a doctor gate that accepted invalid cleanup evidence. The evaluator now preserves the native environment and frozen serial order, uses an already-exported response header alongside body and usage checks, and rejects invalid probe evidence.

## Summary

Both versions received reward zero on three native pilot tasks. The historical dasel trajectory included missing-module and network errors before a completed, empty provider response. A same-image control with networking disabled built the original parsing packages in about 14 seconds under the image home; the wrapper's replacement home failed in about 0.14 seconds and tried downloading modules that were already present under the original home. The environment error is confirmed. Whether it caused the subsequent empty response remains unproven.

The candidate dasel run had three completed requests with identical request bodies. The frozen matcher retained only 245 unique matches among 248 requests and correctly refused complete-evidence admission. Equal aggregate usage did not resolve the ambiguity. That evidence problem did not cause the task's empty committed patch or change its native reward.

The six pilot trials started in plan-index order `0, 2, 4, 1, 3, 5` even though concurrency was one and the frozen list was `0, 1, 2, 3, 4, 5`. The paired sides stayed ordered relative to each other, but other pairs ran between them. A regression reproduced the same dispatch order without a provider.

During the subsequent free task-image audit, the bandit baseline probe completed its tool roundtrip and request reconciliation, then hit a container-cleanup timeout. The retained evidence correctly reported `environment-cleanup_failed` and `valid: false`, but doctor still returned `completed`. The owned containers were later absent; their eventual removal does not erase the timeout or establish why it occurred. This finding blocks an unconditional readiness claim and is preserved separately from task quality.

## Timeline

- 2026-09-21: the frozen pilot and delegated trials completed; unsuccessful native scores, unknown usage and the ambiguous association were retained.
- 2026-09-22: an offline trajectory investigation separated empty provider termination, incomplete task submission and native functional failures.
- 2026-09-22: a benchmark audit identified different home overrides, reproduced the cache failure offline, and added regression controls for native task environment preservation and repeated-request reconciliation.
- 2026-09-22: native start times and a failing scheduler regression confirmed serial-order drift; a retained task-image probe exposed cleanup failure being omitted from the doctor gate.

## Root cause

The historical adapter reused an external-harness wrapper that relocated `HOME` and all XDG directories. Synergy already had a distinct `SYNERGY_HOME`, so the extra isolation changed the task rather than only the product's data. Go derives its default workspace and module cache from the operating-system home, as documented in the [Go module reference](https://go.dev/ref/mod#module-cache). The candidate's native rollout wrapper did not apply those overrides.

Existing deterministic probes used self-contained shell commands and generated text. They exercised transport, cancellation and long tool histories but not image-preinstalled dependencies. Native OracleAgent execution bypassed both Synergy adapters, so a passing reference solution could not establish launch-environment parity.

The gateway generated a unique dispatch ID but exposed it only in a custom header that the public Synergy exporter did not retain. The matcher therefore fell back to content identity. Different calls can have identical content, especially auxiliary calls; one digest cannot prove a one-to-one dispatch association.

The scheduler created a coroutine per pair before acquiring a shared one-slot resource pool. Waiting first sides entered the slot ahead of a just-completed pair's second side. Resource serialization prevented overlap but did not preserve list order. Doctor separately checked process completion, tool output, usage and archive validity without checking the collected terminal evidence's validity or infrastructure failure.

## Guardrails added

- [Adapter subprocess regression](../../benchmark/test/task-environment.test.ts) preserves task HOME/XDG and isolates Synergy data.
- [Actual native CLI controls](../../benchmark/test/test_matrix_docker.py) inspect inherited environment, use a preinstalled cache through the shell tool, complete repeated tool calls, and preserve an empty provider stop without a fabricated timeout.
- [Gateway](../../benchmark/test/test_gateway.py) and [reconciliation](../../benchmark/test/test_usage.py) regressions retain unique response IDs and reject contradictory bodies, swapped usage and duplicates while keeping early cancellation unknown.
- [Scheduling regressions](../../benchmark/test/test_runner.py) verify actual serial order, preservation of completed attempts and continued observation after quality failures.
- [Doctor regressions](../../benchmark/test/test_maintenance.py) reject cleanup, export and infrastructure failures while preserving valid partial recording and unknown interrupted usage.
- The [benchmark workflow](../../.synergy/skill/develop-benchmark/SKILL.md) requires task-environment controls independently of native oracle checks and audits order and cleanup. The [decision record](../decisions/implemented/bug-fix/2026-09-22-benchmark-execution-evidence-integrity.md) defines the repair and historical evidence policy.

## Lessons

Product-state isolation must not silently relocate the task's dependency environment. A native oracle validates a reference solution and verifier; a native harness control validates the adapter and product launch. Both are needed. Content equality is weaker than dispatch identity, a concurrency limit does not prove dispatch order, and a completed tool call does not prove successful cleanup. Fixing future execution and admission does not repair old evidence retrospectively.
