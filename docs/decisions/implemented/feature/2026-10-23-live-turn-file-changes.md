# Decision Record: Observe turn file changes incrementally

Status: implemented

## Problem

Task file changes need timely net statistics without rescanning unchanged file contents, generating full patches or retaining every intermediate edit as permanent history.

## Decision

Snapshot capture accepts Workspace-relative dirty paths and uses the existing byte, link, executable-mode, ignore and omission rules. Ignore-file changes request full calibration. The same Git comparison supplies lightweight statistics and on-demand patches; lightweight results retain every file row.

Runtime-owned live trees use a private temporary object repository with the verified durable baseline as an alternate. Only transient loose objects are written during observation. Reachability excluding the baseline determines reference counts for the latest revision and admitted readers. Releasing the last reference removes only those temporary objects. No live refresh retains a permanent root, creates a durable pack or runs shared-store garbage collection. Session and Scope-qualified opaque revisions expire with their Runtime; unavailable reads fail explicitly.

## Alternatives considered

Accumulating tool patches measures edit activity rather than the net file state and misses other writers. Repeating complete captures reads unchanged bytes and increases durable storage with edit frequency.

## Consequences

Final checkpoints remain authoritative durable evidence. Live readers preserve immutable endpoints while later edits proceed. Directory and ignore-policy invalidation can require broader traversal; ordinary file invalidation reads only the affected bytes.
