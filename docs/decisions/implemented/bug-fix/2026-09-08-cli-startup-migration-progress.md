# Decision Record: CLI startup displays migration progress on stderr

Status: implemented

## Problem

CLI startup completes data migrations before opening the server. The migration runner has terminal rendering, but ordinary startup selects silent output. Long upgrades therefore appear inactive even when work advances. The renderer also waits for the first progress callback before showing the step and emits color sequences into redirected output.

## Decision

Foreground network resolution, background-service setup, and local one-shot execution explicitly request interactive migration output. The reusable runtime handle retains silent output by default and exposes the existing migration output selection to its caller. Managed Desktop continues to select its structured reporter with terminal output disabled.

The shared migration renderer writes the step before invoking migration work, then displays a bounded progress bar, percentage and processed/total counts when a total is known. Counts precede descriptions so long descriptions do not obscure progress in narrow terminals. Unknown totals display preparation status. Existing progress throttling applies, with final counts always emitted. Completion and failure restore terminal wrapping.

All human progress uses stderr, including local JSON-mode sends. TTY output replaces the current line; redirected output appends ordinary text without ANSI sequences. Color respects `NO_COLOR`, and dumb terminals also omit cursor and wrapping controls. Migration execution, checkpointing and errors retain their existing semantics.

## Alternatives considered

**Make every migration invocation interactive by default.** Embedded runtimes, machine transports and custom reporters need explicit output ownership. CLI entry points select rendering while existing silent callers retain control.

**Build a second CLI progress renderer.** The existing migration renderer already owns step descriptions, throttling, completion and terminal cleanup. Extending it keeps manual migration commands and startup consistent.

**Write progress to stdout.** This corrupts JSON output and protocol transports. Human diagnostics belong on stderr.

## Consequences

Terminal users can distinguish migration work from an inactive startup. Redirected progress produces bounded-frequency log lines instead of in-place updates. Tests exercise pre-work visibility, known counts, silent output, failure/retry, terminal capabilities, and real CLI entry points with isolated migration fixtures. Browser pages do not gain a migration interface.
