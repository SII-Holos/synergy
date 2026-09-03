# Decision Record: Fail closed on Linux inotify capacity exhaustion in the workspace watcher

Status: implemented

## Problem

On Linux, opening a large parent workspace can exhaust the kernel inotify watch table (`fs.inotify.max_user_watches`, commonly 65,536). The workspace watcher then entered an unbounded recovery loop: `subscribeWithRecovery` timed out the native subscribe after 10s, retried 1s later, and `createSubscriptionRecovery` classified every failure as transient. In the reported incident (issue #1305, v3.0.22), 50 minutes of retries produced 613 subscription failures, 503 failed cleanups, and 974 "No space left on device" messages while the process went from under 1 GiB to 11.6 GiB private anonymous RSS and the HTTP server stopped responding.

Three defects combined:

1. **Built-in ignores were not recursive.** `workspaceSubscriptionIgnores()` passed plain folder names (`.synergy`, `node_modules`, `dist`, …) to @parcel/watcher 2.5.6. Its wrapper resolves every non-glob `ignore` entry via `path.resolve(dir, value)`, matching one exact top-level path only; nested occurrences — e.g. `<workspace>/.synergy/worktrees/<task>/node_modules/...`, the observed failing path — were still scanned and watched. Only glob entries are matched against every relative path during the recursive walk (`isIgnored` in `Watcher.cc`, `FTS_SKIP` pruning in `unix/fts.cc`).
2. **Linux subscribe attempts cannot be cancelled, yet recovery abandoned them.** The native inotify subscribe builds the directory tree and registers watches on a libuv async-work thread; there is no cancellation. The wrapper's 10s `withTimeout` only abandoned the JS promise. Critically, when a scan fails mid-way (watch capacity exhausted), `Backend::watch` throws **before** inserting the watcher into `mSubscriptions` (`Backend.cc`), so the partial watches and the full `DirTree` of that failed attempt are never released — each retry leaks more native memory and more inotify watches into the process-shared backend.
3. **Capacity errors were retried forever.** `createSubscriptionRecovery` has no terminal-error concept, so an ENOSPC that cannot clear while the process runs was retried every ~11s, each retry re-running the giant scan that exhausted the table.

Every failure also invoked workspace resync, adding a secondary `/workspace/files/children` reload loop (415 requests in the window).

## Decision

Three changes, all scoped to the file watcher:

1. **Recursive folder ignores.** `FileIgnore.WATCH_IGNORES` replaces `FileIgnore.PATTERNS` for native subscriptions: folder names become `**/<name>` globs (`.synergy` becomes `**/.synergy`; `node_modules`, `dist`, `.git`, `worktrees`, … likewise), while the already-recursive file globs pass through unchanged. The `.synergy` runtime subscription and the workspace subscription both use recursive globs. User-configured `watcher.ignore` extras are still passed verbatim so existing top-level-name and absolute-path entries keep their documented meaning.
2. **Inotify capacity errors are terminal.** `FileWatcherEvents.isInotifyCapacityError()` matches "No space left on device"/ENOSPC messages; `isTerminalWatcherError()` gates it on Linux. `createSubscriptionRecovery` gains an optional `terminal(error)` predicate: when it returns true the recovery stops retrying (after one `onError` report, which for watcher.ts logs remediation guidance instead of resyncing). File APIs, browsing, and sessions remain usable; only live file events for that subscription are lost.
3. **Linux waits for a native attempt to settle.** `nativeSubscribeTimeoutMs()` returns `undefined` on Linux, so `subscribeWithRecovery` awaits the raw native subscribe promise without the 10s race; other platforms keep the bounded timeout and the unsubscribe-on-timeout cleanup. Combined with the existing recovery state machine (retry is scheduled only after the previous connect/`onError` settles), scans can no longer overlap.

## Alternatives considered

- **Watch-count preflight on Linux** — rejected: the limit applies process-wide across all scopes and other processes; a snapshot-style count cannot reserve capacity and would still race. Terminal fail-closed plus recursive ignores removes the need to predict success.
- **Subscribing to one directory per configured root instead of one recursive scan** — rejected: it changes watch semantics (no pruning mid-tree) and the number of inotify watches would rise rather than fall for nested trees.
- **Retrying capacity errors with an exponential backoff capped at a long interval** — rejected: the limit cannot clear while the process holds its watches, and each retry leaks the failed attempt's partial watches into the shared native backend (see Problem 2). Retry could only help after a user raises the limit and restarts; a manual restart is the correct recovery and the log message says so.
- **Polling the workspace as a Linux-only fallback when inotify fails** — rejected: it adds a second file-event engine with its own correctness and cost surface, for a condition that is rare and operator-fixable.
- **Fixed upper bound on inotify watches per subscription** — rejected: there is no per-subscription accounting exposed by @parcel/watcher 2.5.6 without forking the binding; the leak itself is eliminated by not retrying.

## Consequences

Live file watching on a Linux scope that exhausts the inotify table now stops cleanly with one actionable error (raise `fs.inotify.max_user_watches` or open a smaller workspace) instead of degrading the process into multi-GiB native retention and an unresponsive HTTP server. Nested dependency/build trees and generated worktrees are excluded from native scans at any depth, so far fewer watches are needed and capacity errors become rarer in the first place. Directory-refresh and document-open paths still read the filesystem directly, so correctness does not depend on the watcher. The trade-off: a subscription stopped for capacity does not self-heal until the process restarts (or the watcher state is reloaded), and on Linux a genuinely hung native scan is no longer abandoned after 10s — recovery waits for the attempt, which is bounded by scan completion and is never overlapped. Other platforms keep byte-for-byte prior behavior: 10s timeout, unsubscribe-on-timeout, and transient retry semantics.
