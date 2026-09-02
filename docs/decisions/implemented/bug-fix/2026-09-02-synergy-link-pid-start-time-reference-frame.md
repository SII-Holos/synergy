# Decision Record: Derive synergy-link pid start times without timezone parsing

Status: implemented

## Problem

The CI Test job failed on every run, including pull requests that touch nothing in `packages/synergy-link`: `isPidRunningSince verifies a live pid and compares start time` in `test/service-local.test.ts` always received `false` for a pid whose expected start time was one second in the past. Local reproduction on an Asia/Shanghai machine was deterministic: `Date.parse("Wed Sep 2 11:23:48 2026")` returned a value 28,800 seconds (exactly 8 hours, the local UTC offset) ahead of `Date.now()`, far outside the 5 s tolerance.

## Decision

`readPidStartedAt` in `packages/synergy-link/src/service/local.ts` derives the start instant from the process elapsed runtime instead of parsing `ps -o lstart=`: it reads `ps -o etimes=` (whole seconds a process has been running) and returns `Date.now() - etimes * 1_000`. The value stays in the caller's `Date.now()` reference frame (epoch milliseconds) regardless of how the running JS engine interprets timezone-less date strings, and the 5 s tolerance comfortably absorbs the seconds granularity of `etimes`.

## Alternatives considered

- **Keep `lstart` and parse it explicitly as local time** — rejected: the failure is that engine behavior for timezone-less strings differs between the parse path and the current-time path (Bun's JavaScriptCore produced two different reference frames within one process); reimplementing a locale-format parser would reintroduce that fragility.
- **Parse `lstart` with an explicit GMT suffix** — rejected: `ps` prints `lstart` in local time, so appending `GMT` would misinterpret the wall clock by the full offset; formatting `ps` output with long options (`-o lstart= --time-style`) is not portable across procps and macOS's ps.
- **Drop the start-time comparison and accept any running pid** — rejected: the check exists to reject a recycled pid whose start time does not match the persisted service record; removing it weakens the service identity guard.

## Consequences

`isPidRunningSince` now behaves identically across engines, distributions, and timezones; the CI Test job on `ubuntu-latest` (UTC) covers the default path, and non-UTC developers no longer see the deterministic 8-hour mismatch. `Dates.parse` is no longer involved in pid identity; log-timestamp parsing elsewhere in the file is unaffected because those timestamps carry explicit ISO offsets.
