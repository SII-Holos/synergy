# Decision Record: Exclusive host instruction sources

Status: implemented

## Problem

Hosts can replace configuration and model catalogs, but instruction discovery also reads global files independently of those selections. An isolated Runtime needs a complete instruction-source choice without duplicating prompt assembly or changing personal behavior.

## Decision

Harness exposes a Runtime-scoped `InstructionSource` registration, sealed with composition. The loader receives the current Scope and Workspace. Its result replaces every implicit instruction source; errors propagate and an empty result does not trigger fallback. Hosts without a registration retain the personal loader.

`InstructionFiles.project()` reuses project discovery and presentation while restricting reads to the selected project's physical directory. It excludes global and explicit additions, rejects escaped paths and symlinks, and uses bounded regular-file descriptor reads with identity checks. POSIX opens refuse final symlinks and nonblocking opens prevent special-file replacement from hanging. The cache separates contained reads from legacy reads.

## Alternatives considered

**Rely on an isolated Home alone.** Project configuration can name external instruction files, and global discovery has independent sources. Directory selection alone does not express the host's policy.

**Copy project discovery into each host.** This would duplicate filename priority, ordering, byte limits and cache invalidation, making later changes diverge.

**Make the personal loader project-only globally.** Personal workflows intentionally use global and explicit instructions. Their defaults do not need to change for an explicitly isolated host.

## Consequences

Instruction selection is explicit and testable per Runtime. Hosts must register their source in each process that assembles prompts. Project-only reading narrows automatic disclosure; it does not replace execution sandboxing or authorization of the selected Workspace. Behavioral tests cover conflicting Runtime sources, failure propagation, path escapes, symlink replacement and unchanged personal discovery.
