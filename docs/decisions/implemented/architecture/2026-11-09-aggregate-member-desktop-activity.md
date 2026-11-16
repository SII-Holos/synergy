# Decision Record: Aggregate member activity into the Desktop power assertion

Status: implemented

## Problem

Desktop's keep-awake watcher observes the personal server. A supervised member can be active while that server is idle, so its work does not keep the machine awake. Giving each member its own OS assertion would duplicate power ownership and make shutdown and preference changes harder to coordinate.

## Decision

The existing power owner aggregates independent activity watchers before applying its single OS guard. Each watcher retains its request deadline, failure grace, idle debounce and generation checks. The personal source resolves the current server; each member source captures its child connection and private HTTP credential. The generated SDK reads the activity endpoint with omitted cookies, no cache and refused redirects.

The opt-in setting starts or stops the whole group. Adding a member while disabled performs no polling. A member's attached-service cleanup removes its source, cancels its request and recomputes aggregate activity immediately. Another active member preserves the assertion. Late responses from removed sources cannot rejoin the group. Resume rechecks reapply aggregate intent so a lost OS assertion can be reacquired.

The existing [Desktop power decision](../feature/2026-09-19-desktop-prevent-sleep-while-running.md) remains authoritative for the server activity predicate, local preference and platform limits. The renderer supplies only a recheck hint and never a new activity authority.

## Alternatives considered

**Use one OS assertion per member.** This adds owners for the same local preference and makes member removal, setting changes and quit depend on releasing every independent assertion.

**Combine HTTP results in one all-or-nothing poll.** One unavailable member would delay or invalidate another member's activity. Independent watchers retain their own failure and cancellation state.

**Infer activity from the open organization space.** Members continue without an open renderer, and selecting a space is not evidence that its Runtime is executing work.

## Consequences

Polling costs one bounded read per live source while enabled and none while disabled. Tests verify aggregation, source removal, late responses, credential separation, preserved base paths and redirect rejection. A real macOS Electron fixture observes one process-owned assertion with two active authenticated sources, retains it after window close and one source removal, and releases it on preference changes, final source removal and quit. It verifies OS assertion registration and cleanup, not actual hardware sleep or Windows/Linux power behavior.
