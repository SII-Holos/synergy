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

- [Network admission](../../benchmark/src/synergy_bench/network_resources.py) counts whole available subnets from Docker's configured or documented default local pools, excluding existing networks and host routes. Unknown samples pause admission.
- [Environment resource requests](../../benchmark/src/synergy_bench/environment.py) declare one or two network allocations before container startup. First-sample admission keeps the next cell behind actual allocation by the preceding cell.
- [Resource regressions](../../benchmark/test/test_network_resources.py) cover pool exhaustion, release, route overlap, unknown inspection and 48 unique cells queueing behind a two-network budget.
- The [development Skill](../../.synergy/skill/develop-benchmark/SKILL.md) requires network-capacity coverage alongside CPU and memory, and separates terminal-cell counts from observed scores.

## Lessons

A large configurable concurrency ceiling does not establish that native environments can all start. Free tests must exercise the resource model at each limiting boundary. A failed full study must retain its gaps; improving the evaluator does not authorize replacement executions or make an incomplete comparison complete.
