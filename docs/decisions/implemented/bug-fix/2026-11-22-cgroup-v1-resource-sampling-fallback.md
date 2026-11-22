# Decision Record: Sample Linux memory across cgroup hierarchies

Status: implemented

## Problem

Missing memory samples leave execution waiting for admission. A host-only sample can also overstate the capacity of a constrained container.

## Decision

The native resource sampler reads the memory controller selected by the process membership and mount table. On cgroup v1 it pairs each visible hard limit with usage from the same directory, including the parent that also accounts for siblings. A stricter inherited limit reported by memory.stat with no visible usage has zero known headroom. V1 observations have partial quality. The admission policy already takes the minimum across the physical and constrained domains. [Linux v1 memory accounting](https://docs.kernel.org/admin-guide/cgroup-v1/memory.html)

On v2, a directory with neither memory counter can lack the controller. Sampling continues up the hierarchy. A partially readable limit/usage pair or an unresolved memory mount fails the sample. A delegated v2 mount with no visible hard capacity cannot establish headroom for a hidden parent. A machine with no memory-controller membership can still supply a partial physical snapshot. [Linux v2 memory controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory)

## Alternatives considered

Using physical availability alone loses the usage charged to sibling containers. Treating every missing child controller as fatal blocks workloads even when the parent exposes sufficient accounting.

## Consequences

Unobservable hard limits keep admission conservative. Missing optional v1 pressure information permits the existing partial-sample policy.

## Verification

The resource suite covers hybrid membership, nested limits, absent controllers, unreadable counters and the current host. An isolated arm64 Linux guest booted with real v1 and v2 mounts also ran the sampler and admission gate. A child under a 256 MiB parent stayed bounded by that parent's usage on each hierarchy, including a v2 child without delegated memory accounting.
