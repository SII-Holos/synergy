# Decision Record: cgroup v1 hosts fall back to partial resource snapshot

Status: implemented

## Problem

On hosts without cgroup v2 memory accounting (cgroup v1 or controller-less mounts), the Linux resource sampler in `packages/local-runtime/src/resources/linux.ts` threw: `Cgroup memory accounting requires v2` when no v2 mount exists, or `Cgroup hard limit is unreadable` when a directory lacks `memory.current`/`memory.max`. A failed sample feeds the runtime memory admission gate an unavailable snapshot, which keeps the gate blocked forever — every session stalls at input materialization and no LLM turn ever starts.

## Decision

Sampler degrades to a `partial`-quality snapshot built on the `/proc/meminfo` physical-memory domain instead of throwing:

- No cgroup v2 directories resolved while the process has cgroup membership: mark `quality = "partial"` and continue instead of `Cgroup memory accounting requires v2`.
- A resolved directory without the v2 controller files: mark `quality = "partial"` and skip that directory instead of `Cgroup hard limit is unreadable`, regardless of position in the ancestor chain.

Cgroup v2 hosts are unchanged: directories with both counters still produce cgroup domains, reclaim-credit and pressure handling are untouched. Failures unrelated to cgroup structure (unreadable host meminfo, malformed counters that do parse) still throw.

## Alternatives considered

- **Probe startup and disable admission on v1**: admission would silently change semantics per host; a sampler-level partial snapshot keeps one admission path with visible quality.
- **Implement cgroup v1 accounting reading**: v1 hierarchy layouts vary (multiple mounts, named hierarchies) and the physical `/proc/meminfo` domain already bounds admission adequately; reading v1 adds parsing risk for a shrinking host population.
- **Keep throwing**: leaves all sessions permanently blocked on v1 hosts with no operator-visible recovery path.

## Consequences

Costs: on v1 hosts the snapshot carries only host-level physical memory (no per-process cgroup limit), reported as `partial` quality so consumers can distinguish it; reclaim-credit prediction is unavailable there. Buys: sessions start and admission drains on v1 hosts with no configuration; v2 behavior is bit-for-bit preserved, so the larger v2 deployment base sees no change. Covered by `packages/local-runtime/test/resources/native.test.ts` cases for both the no-v2-mount path and the controller-less-directory path.
