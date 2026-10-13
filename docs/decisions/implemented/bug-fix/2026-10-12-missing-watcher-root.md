# Decision Record: Stop watcher recovery when its subscription root disappears

Status: implemented

## Problem

A removed worktree cannot accept a native file subscription. Treating that failure as transient schedules repeated scans and repeated errors for a resource that its owner has removed. A rejected subscribe Promise also reached the late-unsubscribe error handler, reporting a second failure for cleanup that never happened.

## Decision

After a subscription failure, recovery checks the exact subscription root. A missing root, a non-directory root or an `ENOTDIR` ancestor stops automatic retry until explicit watcher reload. Failure inside a surviving root remains retryable, including permission errors and a disappearing child. The asynchronous decision shares the subscription's disposal and generation ownership; disposal cannot schedule a replacement attempt. Git discovery tolerates the same missing-root condition during initialization, retaining an inactive watcher that explicit reload can replace.

The timeout wrapper distinguishes subscribe rejection from cleanup failure. A timed-out subscription that eventually succeeds is unsubscribed; only failure of that actual unsubscribe is reported as cleanup failure. Linux retains its uncancellable scan and capacity-breaker rules from [Linux watcher recovery](2026-09-03-linux-inotify-watcher-recovery-loop.md).

## Alternatives considered

**Stop for every native error containing a missing-path message.** Rejected because native scans can report a disappearing child while the root remains valid. The filesystem check classifies the subscription root rather than interpreting platform-specific error text.

**Poll until the root returns.** Rejected because a deleted worktree has no active resource to watch. Explicit reload establishes fresh ownership and permits recovery without an indefinite background retry loop.

## Consequences

Deleted roots stop consuming retry work; recreated roots require reload. Tests cover deferred terminal decisions, disposal, stale callbacks, real native root removal/restoration, and rejection versus late-timeout cleanup. This change does not establish a cause or fix for a JavaScriptCore native assertion observed in the same runtime.
