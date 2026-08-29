# Decision Record: single-flight plugin runtime startup

Status: implemented

## Problem

Concurrent `ensureRuntime()` / `start()` calls for the same `pluginId@version#generation` spawned duplicate external runner processes. `start()` reused an existing registry entry only when its state was `ready`; a caller arriving while the first startup was still `starting` ran startup again and spawned a second process. Both entries share one registry key, so `registry.set()` overwrote the first entry without stopping its process. The overwritten process stayed alive in the Synergy cgroup, unreachable by stop or memory-recycle logic and invisible to `resourceStats()`, which enumerates registry entries. Nine runner processes for one artifact were observed spawning in the same second, adding roughly 390 MiB of unaccounted RSS.

## Decision

`PluginRuntimeManager.start()` is single-flight per runtime key. The manager keeps `#starts`, a map from `pluginId@version#generation` to the in-flight startup promise. A caller that finds an entry in the map awaits that same promise and receives the same registry entry as the first caller; the map slot is removed in a `finally` block, so a failed startup clears the slot and a later call can retry. Keys remain per generation, so different generations still start independently and the atomic generation swap is preserved.

## Alternatives considered

**Return the existing `starting` entry without awaiting readiness** — rejected: callers must not receive a non-`ready` entry; `invoke()` and activation assume readiness, and awaiting the shared in-flight promise inside `start()` is what makes the join correct.

**Store the startup promise on the registry entry** — rejected: the registry is a plain data store shared with diagnostics and the memory-recycle path; the in-flight promise is manager concurrency state, and a private map keeps the entry contract unchanged.

**Serialize starts per key with a mutex** — rejected: joining the in-flight promise returns the identical entry to every caller with no queueing, which is the required behavior; a mutex would add latency without changing the outcome.

## Consequences

At most one startup attempt is in flight per runtime key; concurrent callers share one process and one registry entry, so `resourceStats()` process counts match the managed process count. A failed startup leaves the pre-existing `crashed` entry observable in the registry (process mode) and clears the in-flight slot, so retry remains possible. Generation keys stay independent, so concurrent starts of different generations continue to produce separate runtimes.
