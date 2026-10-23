# Decision Record: Observe turn file changes incrementally

Status: implemented

## Problem

Task file changes need timely net statistics without rescanning unchanged file contents, generating full patches or retaining every intermediate edit as permanent history.

## Decision

Snapshot capture accepts Workspace-relative dirty paths and uses the existing byte, link, executable-mode, ignore and omission rules. Ignore-file changes request full calibration. The same Git comparison supplies lightweight statistics and on-demand patches; lightweight results retain every file row.

Runtime-owned live trees use a private temporary object repository with the verified durable baseline as an alternate. Only transient loose objects are written during observation. Their repository disables per-object fsync because live tokens never survive a restart; durable snapshot repositories retain their existing synchronization policy. Reachability excluding the baseline determines reference counts for the latest revision and admitted readers. Releasing the last reference removes only those temporary objects. No live refresh retains a permanent root, creates a durable pack or runs shared-store garbage collection. Session and Scope-qualified opaque revisions expire with their Runtime; unavailable reads fail explicitly.

The Session owner combines Workspace-qualified revisions, publishes exact totals through the existing sequenced root-message event and exposes a compact current-root query independent of transcript residency. Review acquires one opaque comparison lease for its file list, patch and content reads. Refresh is explicit; final publication releases current live ownership only after acceptance. Failure preserves recorded counts with incomplete status. Failed checkpoint admission and rejected publications release unaccepted watchers and revisions. Diagnostic summaries retain at most 32 issues within 8 KiB; checkpoint omission evidence remains complete. Portable copies remove Runtime-only tokens.

The composer activity area wraps according to available conversation width. Progress, delegated activity and turn changes can share a row. The complete changes surface opens Review through the existing desktop or mobile route; there is no separate action button. Expanded progress uses the stable activity-row positioning container so changing summary widths cannot displace the panel. Current-root recovery respects rollback visibility and event watermarks without depending on loaded messages.

## Alternatives considered

Accumulating tool patches measures edit activity rather than the net file state and misses other writers. Repeating complete captures reads unchanged bytes and increases durable storage with edit frequency.

## Consequences

Final checkpoints remain authoritative durable evidence. Live readers preserve immutable endpoints while later edits proceed. Directory and ignore-policy invalidation can require broader traversal; ordinary file invalidation reads only the affected bytes. Large text statistics avoid per-file object-tree subprocesses. Temporary raw-content batches are deleted after hashing, including batches before the final flush. Immutable readers and maintenance contention have behavioral coverage.
