# Benchmark concurrency exhausted Docker network addresses

## Executive summary

The first adaptive local-24 run lost 21 of 48 cells before model execution because Docker exhausted its default bridge address pools. CPU and memory admission worked, but omitted network capacity. A 48-cell scheduler test and eight concurrent native fixture cells passed without reaching the real network limit. Admission must account for every resource consumed by the native environment, and failed cells remain missing instead of being retried to improve the report.

## Summary

The study compared two immutable product versions across 24 tasks. Each ordinary environment needed one Docker bridge network; restricted-egress tasks needed an additional internal network. On the observed daemon, the default pools supplied 31 subnets, with the default bridge occupying one. The newly increased concurrency consumed all 30 available allocations while CPU and memory still allowed more cells.

Twenty-one environment starts failed with `all predefined address pools have been fully subnetted`. They produced no model calls or native rewards. Their owned resources were removed and the remaining started tasks continued under the frozen evaluator. Those failures are infrastructure observations, not model reward 0. No failed cell was replayed, no shared daemon settings were changed, and no global network prune was used.

## Timeline

- 2026-09-23: free fixed-version unattended controls, adaptive scheduler regressions and eight concurrent native fixture cells passed.
- The new study froze its evaluator and dispatched the 48 formal cells directly.
- While active concurrency increased, native Compose startup logs recorded exhausted address pools for 21 cells.
- Read-only inspection found 30 study-owned networks supporting 27 active cells, including three extra internal egress networks. The remaining cells had already reached terminal environment failure, with unknown scores.
- The follow-up evaluator adds network admission for future experiments. The running study retains its original evaluator and failed evidence.

## Root cause

The resource lease represented memory and CPU but treated network creation as an ordinary preparation operation. Once those compute constraints were relaxed, the scheduler reached a different finite resource that had not been modeled. Each restricted-egress environment's second network made the effective limit lower than the task count.

The deterministic 48-cell test verified uniqueness and compute leases. The real Docker fixture verified concurrency, grading and cleanup at eight cells. Neither exhausted the address allocator. Reading the completed-cell counter alone would also be misleading: it includes recorded environment failures and is not a count of successfully graded tasks.

## Guardrails added

- The initial remediation estimated available subnets from Docker pools, existing networks and host routes. Its tests covered exhaustion, release, overlap and unknown inspection, but the host-route assumption did not describe Docker Desktop's network namespace. The [subsequent admission decision](../decisions/implemented/architecture/2026-09-27-benchmark-docker-resource-admission.md) records why that estimator was replaced.
- [Environment admission](../../benchmark/src/synergy_bench/environment.py) uses native Compose create to reserve actual networks before starting containers. Recognized address-pool exhaustion queues only after project-scoped cleanup is verified and the provisional lease is released.
- [Admission regressions](../../benchmark/test/test_docker_admission.py) cover partial creation, unknown failures, cancellation and debug retention. [Free Docker controls](../../benchmark/test/test_docker.py) verify ordinary, disabled and internal/egress topology and owned-resource cleanup.
- The [development Skill](../../.synergy/skill/develop-benchmark/SKILL.md) requires actual network admission and shared resource-budget coverage, and separates terminal-cell counts from observed scores.

## Lessons

A large configurable concurrency ceiling does not establish that native environments can all start. Free tests must exercise the resource model at each limiting boundary. A failed full study must retain its gaps; improving the evaluator does not authorize replacement executions or make an incomplete comparison complete.
