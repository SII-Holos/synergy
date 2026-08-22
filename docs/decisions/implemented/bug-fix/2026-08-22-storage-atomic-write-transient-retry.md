# Decision Record: Retry transient EPERM/EACCES in atomic JSON persistence

Status: implemented

## Problem

On Windows, session-state persistence intermittently failed with `EPERM: operation not permitted, rename '.tmp-<pid>-<rand>' -> 'info.json'`, terminating background subagents and agenda runs through `SessionTerminalError` and leaving DAG/taskboard nodes failed until manually re-dispatched (#1247).

Every persisted session object (info, messages, parts, dag, todo, inbox, agenda) funnels through `Storage.write`/`Storage.update` → `writeJsonAtomic` in `packages/synergy/src/storage/storage.ts`, which performed a single unguarded `Bun.write` + `fs.rename`. Node's `rename` maps to `MoveFileEx` on Windows: when another process holds a handle on the source or target without `FILE_SHARE_DELETE` — antivirus scans, OneDrive sync, or Synergy's own cross-process readers — the call fails with `EPERM`/`EACCES`. Such sharing violations typically clear within milliseconds, but one occurrence escalated fatally: the write error propagated up the invoke loop, was persisted as a terminal assistant-message error, and `selectResultMessage` rethrew it as `SessionTerminalError`.

The repository already classified these codes as transient in `packages/synergy/src/util/io-retry.ts` (`EPERM`/`EACCES`/`EBUSY`, "Windows sharing violations, antivirus scans, OneDrive sync"), but only the read side used it; the write path had no retry.

## Decision

`writeJsonAtomic` retries the whole write+rename sequence on transient I/O errors:

- Up to 4 attempts with exponential backoff (50 ms base, 200 ms cap), reusing the same temp-file name so a retry overwrites the previous partial temp write.
- Retry classification reuses `isRetryableIOError` from `@/util/io-retry` — only `EPERM`/`EACCES`/`EBUSY` retry; permanent errors (`ENOENT`, `ENOSPC`, genuine permission failures) propagate on the first occurrence.
- On exhaustion or non-retryable failure the original error propagates unchanged after the temp file is unlinked, so no `.tmp-*` residue is left behind on the failure path.

The diagnostics pending-session scan (`packages/synergy/src/observability/diagnostics.ts`), a cross-process reader of the same `info.json` files, now reads through `readFileWithRetry` so its own reads survive a concurrent atomic rename on Windows instead of silently dropping sessions from the dashboard.

Behavioral coverage lives in `packages/synergy/test/storage/storage-retry.test.ts`: transient rename failure recovers, transient temp-write failure recovers, exhausted retries propagate the original `code`, non-transient errors fail on the first attempt, and no temp files remain on any failure path.

## Alternatives considered

- **Catch `EPERM` in the session invoke loop** — rejected: it scatters storage-layer concerns into the session state machine, cannot distinguish transient from permanent failures at that altitude, and leaves the persistence gap unfixed for every other `Storage` consumer (notes, agenda, channels, lattice).
- **Cross-process file locking (properLockfile-style)** — rejected for this fix: it adds a locking subsystem across processes, cannot control third-party handle holders (antivirus, OneDrive) that cause the violation, and addresses the separate lost-update problem rather than the observed crash. The in-process `Lock` keeps serializing same-process writers as before.
- **Windows-native `ReplaceFile`/`FILE_SHARE_DELETE` handling** — rejected: requires platform-specific native bindings and divergent write paths per OS for a failure mode that bounded retry demonstrably clears.
- **Downgrade `SessionTerminalError` to a retryable error only** — rejected: it stops killing subagents but still fails the write; the issue's core request is that persistence succeed under transient contention.

## Consequences

Transient Windows sharing violations during state persistence now absorb within roughly 50–350 ms instead of terminating sessions; permanent I/O failures keep failing fast with their original error codes. A permanently held handle costs up to ~350 ms of additional latency before the failure surfaces. The exhausted-retry error still propagates as before, so upstream terminal-error handling is unchanged. macOS and Linux behavior is untouched in practice (their renames do not produce these sharing violations) but gains the same bounded resilience. The fix does not address cross-process read-modify-write races on the same key — the process-local `Lock` was and remains same-process only; that lost-update concern is separate and unowned by this change. Windows sharing violations cannot be reproduced natively on the development platform, so verification relies on injected errno errors; real-machine confirmation depends on reporter feedback on #1247.
