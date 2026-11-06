# Decision Record: Session-switch telemetry measures data readiness and keeps the phase label

Status: implemented

## Problem

Session-switch instrumentation could not attribute its own latency, and part of the latency it reported was an artifact of the instrumentation itself.

Two independent defects produced that state. First, the `phase` label was dropped for every row. The browser sent one `frontend.session_switch.phase.duration` sample per navigation mark (`components/performance/browser-metrics.ts` passed `phase` unchanged), but the host enum gate `ObservabilityBrowserMetrics.ENUM_LABELS` admitted only `receive`, `apply`, `paint`, `fetch`, `sync`, `render`, `complete`, and `timeout`, while the recorded mark names are `session:params`, `session:data-ready`, `session:first-turn-mounted`, `storage:prompt-ready`, `storage:terminal-ready`, `storage:file-view-ready`, and `navigate:start`. `browserLabelValue` drops a value outside the enum, so all 494 stored `phase`-bearing rows carried no `phase` at all and the per-phase breakdown was empty. Because the mark names were a hard-coded set duplicated across two packages with no shared source of truth, nothing failed when they diverged.

Second, `reason=complete` did not mean what it said. `flush(id, "complete")` fired only once every name in the `required` array was present, and that array mixed session prerequisites (`session:params`, `session:data-ready`) with three panel-level marks (`session:first-turn-mounted`, `storage:prompt-ready`, `storage:terminal-ready`, `storage:file-view-ready`). A switch that rendered no panel could never satisfy `required`, so the navigation was resolved by the 5000 ms timeout instead. Of 85 measured `session_switch.duration` samples, 48 landed at approximately 5000 ms for that reason, which made the reported `complete` distribution (`p50` 500 ms, `p90` 1950 ms) and the timeout distribution two different populations rather than a slow and a fast path.

No runtime evidence could separate those causes while the labels were missing: the panel showed a switch duration with no phase attribution, and a large share of it was the timer, not the switch.

## Decision

- `utils/perf.ts` narrows `required` to exactly `["session:params", "session:data-ready"]`, so `flush(id, "complete")` fires when session data is ready. `reason=complete` now means "session data ready", and `reason=timeout` means the readiness marks never arrived within 5000 ms. The four remaining `navMark` call sites still record into `nav.marks`, still emit their own phase durations when they land inside the window, and still appear in the `dev` `perf.session-nav` log; they no longer gate completion.
- `ENUM_LABELS.phase` in `packages/harness/src/observability/browser-metrics.ts` admits the seven real mark names in addition to the original eight generic values. Both sets are retained because the generic values remain valid for other phase-bearing metrics and historical rows must stay readable. The `SAFE_DIMENSION` bound is unchanged: `:` was already accepted by `[A-Za-z0-9_.:-]{1,80}`, so the mark names need no escaping.
- `apps/web/test/components/performance/browser-metrics.test.ts` scans `apps/web/src` for every `navMark({ name })` call and every direct `nav.marks[...]` write, parses the enum out of the host file, and fails when a recorded mark is not registered. The test reads the host source as text rather than importing it, because `apps/web` declares no dependency on the harness package and an import would trip the test-home guard under the suite's plain `bun test`; this matches the existing source-contract test pattern in the repository.

## Alternatives considered

**Widen the enum to accept any safe string and drop the allowlist for `phase`.** Rejected: the allowlist is what keeps an unbounded or attacker-influenced value out of an indexed, aggregatable column, and `phase` is grouped by in queries. Accepting arbitrary values would trade a silent-drop bug for unbounded label cardinality in the same column.

**Keep `required` as-is and treat the 5000 ms samples as genuine slowness.** Rejected on evidence: a panel mark cannot exist for a switch that renders no panel, so those samples measure the timer's duration rather than the switch, and leaving them in the same `reason=complete` population would corrupt the baseline the improvement is measured against.

**Rename the marks to match the existing generic enum values instead of extending the enum.** Rejected: the mark names are the observable contract of the session-switch path and are already emitted to the `dev` log and read by developers; renaming them to `render`/`paint` would lose which step a duration belongs to and require touching every call site to make the data less specific.

**Share one mark-name constant between `apps/web` and the harness package.** Rejected for now: it would give `apps/web` a runtime dependency on the harness package that it does not otherwise have, purely to carry a list of strings. The source-contract test gives the same failure signal without the dependency edge.

## Consequences

Per-phase switch durations are now attributable: a stored row carries the mark name that produced it, so the panel can separate `session:params`, `session:data-ready`, and the panel-level marks instead of showing one undifferentiated total. Because the panel marks no longer gate completion, the `reason=complete` distribution shrinks to switches that actually reached session data readiness and becomes comparable across revisions, at the cost of shifting the comparison baseline: `reason=complete` before this change included both data-ready and timeout cases and is not directly comparable with the values recorded after it. The timeout population keeps its meaning and stays measured, so a genuine readiness regression still shows up as `reason=timeout` rather than disappearing.

The enum extension is additive and leaves historical rows readable, and the new invariant test turns any future unregistered mark into a test failure instead of a silently missing label. The user-visible switch behavior is unchanged: this change alters what the instrumentation reports and which timer resolves a navigation, not how a session loads.
