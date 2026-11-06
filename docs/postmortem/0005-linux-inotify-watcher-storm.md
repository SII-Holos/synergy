# 0005 — Linux inotify exhaustion stormed the file watcher and degraded the process

## Executive summary

On Linux, opening a workspace whose file tree needed more inotify watches than the kernel budget allowed put Synergy into an unbounded recovery loop: every ~11 seconds the file watcher re-ran the giant recursive scan that had exhausted the table, leaking partial native trees and watch descriptors each time. In the reported incident (issue #1305, v3.0.22) 50 minutes of retries produced 613 subscription failures, 503 failed cleanups, and 974 "No space left on device" messages while the process grew from under 1 GiB to 11.6 GiB private anonymous RSS and the HTTP server stopped responding. It escaped because capacity errors were classified as transient and retried forever, recursive ignores were not recursive, and the native scans that failed mid-way could not be abandoned safely. The fix fails closed on capacity, prunes nested generated trees at any depth, and serializes native scans so a capacity failure stops further scanning instead of compounding it.

## Summary

A user running Synergy on Linux with a large parent workspace (containing generated worktrees with their own `node_modules`) hit kernel inotify watch-table exhaustion (`fs.inotify.max_user_watches`, commonly 65,536). The workspace watcher's `subscribeWithRecovery` wrapped the native subscribe in a 10s timeout and retried failed attempts every ~1s (plus recovery scheduling), and `createSubscriptionRecovery` treated every failure as transient — so an ENOSPC that cannot clear while the process holds its watches was retried forever. Every retry re-ran the full recursive scan; when a scan failed mid-way, @parcel/watcher's `Backend::watch` threw before inserting the watcher into `mSubscriptions`, so the partial watches and full `DirTree` were never released. Each retry therefore leaked more native memory and more inotify watches, and every failure also invoked a workspace resync, adding a secondary `/workspace/files/children` reload loop.

## Timeline

- User reported Synergy on Linux becoming unresponsive after opening a large parent workspace; HTTP server stopped answering and process RSS climbed without bound.
- Diagnostics showed the watcher retry storm: 613 subscription failures, 503 failed unsubscribes, 974 "No space left on device" messages, 415 workspace-children reloads over the incident window.
- Source tracing identified three compounding defects: non-recursive built-in ignores (nested `node_modules`/`.synergy`/generated worktrees were still scanned), the 10s timeout abandoning an uncancellable native scan (whose late failure leaked partial watches into the shared backend), and no terminal-error classification for capacity exhaustion (so ENOSPC retried forever).
- Fix landed as PR #1306 with a follow-up hardening round: recursive glob ignores, Linux capacity fail-closed with remediation guidance, Linux waits for native scans to settle, a process-wide breaker, and serialized native Linux scans.

## Root cause

Three defects combined into the storm:

1. **Built-in ignores were not recursive.** Plain folder names (`.synergy`, `node_modules`, `dist`, …) resolve to one top-level prefix path in @parcel/watcher; nested occurrences — e.g. `<workspace>/<subproject>/.synergy/worktrees/<task>/node_modules` — were still scanned and watched.
2. **Linux subscribe attempts cannot be cancelled, yet recovery abandoned them.** The 10s `withTimeout` abandoned the JS promise but the native scan kept running; a scan that later failed mid-way leaked its partial watches and `DirTree` into the process-shared backend.
3. **Capacity errors were retried forever.** ENOSPC cannot clear while the process runs, but every ~11s a retry re-ran the giant scan that exhausted the table, each time leaking more native state and triggering a resync reload loop.

Why the safety nets missed it: no test exercised a native subscription against a nested ignored tree; the recovery state machine had no terminal-error concept; and the timeout masked the uncancellable-scan leak until the incident topology (huge tree + capacity ceiling) appeared.

## Guardrails added

- **Recursive folder ignores** layered on top of the existing plain names (`**/<name>/**`), so nested dependency/build trees and generated worktrees prune at any depth of the Linux tree walk and in every backend's event filter.
- **Capacity exhaustion is terminal and Linux-gated** (`ENOSPC` / "No space left on device"): the failing subscription stops with remediation guidance (raise `fs.inotify.max_user_watches` or open a smaller workspace, then reload watcher state or restart) instead of resyncing or retrying.
- **Linux waits for a native attempt to settle** instead of racing it at a 10s timeout, so scans cannot overlap and a failed attempt's partial watches cannot accumulate behind a fresh scan; watcher state initialization never blocks on a native settle.
- **Process-wide breaker and serialized Linux scans**: the first capacity failure trips a module-level breaker that stops later subscriptions from scanning; native Linux scans run through a process-wide serial queue so concurrent subscriptions cannot each exhaust the table before the breaker trips. `FileWatcher.reload()` resets the breaker and re-creates the live subscriptions.
- **Stall observability for serialized Linux scans**: a scan that hangs rather than failing (typically a network-filesystem subtree) is never cancelled — it emits one stall warning after 60 seconds and a settle notice when it ends — and capacity exhaustion is reported once per process with full remediation, with later subscriptions logging a single bounded warn, so the serial gate cannot trade the leak for silence.
- Tests pin the classifier, the ignore-list shape, the platform timeout policy, the breaker, and the serial queue; the upstream @parcel/watcher ignore semantics are cited beside the implementation. See the [decision record](../decisions/implemented/bug-fix/2026-09-03-linux-inotify-watcher-recovery-loop.md).

## Lessons

- A resource that cannot clear while the process runs must fail closed, not retry — retrying a capacity error compounds the exhaustion it is responding to.
- A timeout that abandons a promise without cancelling the underlying native operation converts a slow path into a leak; cancellation and abandonment are different guarantees.
- "Ignore this folder" must specify whether it means top-level only or anywhere in the tree; when the native contract distinguishes the two, tests should pin the actual pruning behavior, not the string list.
