# Computer Protocol Rules

This private package owns bounded native Computer commands, results and host transport schemas. Keep it independent from Electron, session storage, permissions, and native process execution.

- Default actions target an observed application window and use background delivery. Never silently replace a failed background action with foreground input.
- Task identities come from the runtime; driver session identities are host-owned.
- Protocol success describes driver dispatch, not completion of the user's application task.

Run `bun run typecheck`, `bun run build`, and `bun run test:coverage`, then affected Desktop and core Computer tests. Coverage is enforced through the root manifest with no source exemptions. Regenerate the SDK when these schemas enter OpenAPI.
