# Terminal UI Rules

This package owns Synergy's first-party terminal client. Root `AGENTS.md` still applies.

- Keep the TUI a thin client of the generated `@ericsanchezok/synergy-sdk`; never import core runtime implementation or duplicate session, permission, question, workflow, or persistence truth.
- Treat every server-, model-, plugin-, tool-, path-, and user-provided string as untrusted terminal content. Sanitize control sequences before rendering while preserving ordinary Unicode and newlines.
- Keep state convergence deterministic: bootstrap establishes a snapshot, sequenced events advance the watermark, replay fills gaps, and reset/epoch mismatch triggers a fresh bootstrap. Streaming deltas are provisional until full checkpoints arrive.
- Terminal ownership is explicit. Restore raw mode, cursor, mouse, paste mode, and alternate screen on normal exit, signals, exceptions, and failed startup.
- Keep reducers, input handling, sanitization, and text rendering pure where possible. Cover them with Bun tests; use OpenTUI's test renderer only for terminal layout/interaction integration.
- Run `bun run typecheck`, `bun test`, and `bun run compile:smoke` from this package, then root `bun run quality:quick`.
