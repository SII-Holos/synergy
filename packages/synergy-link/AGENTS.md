# Synergy Link Host Rules

This package owns the remote Link host, CLI, local/managed service, Holos transport, control socket, RPC handlers, approvals, process execution, and durable host state.

- Use `@ericsanchezok/synergy-link-protocol` as the wire contract. Do not create private duplicate envelopes or accept data without protocol validation.
- Keep authentication, owner registration, inbound routing, RPC correlation, approval, execution, cancellation, and terminal settlement distinct. A connected transport is not authorization to execute.
- Route Bash/process work through the host approval and process registry. Preserve output bounds, abort behavior, cleanup, and explicit remote error envelopes.
- Put durable state changes in versioned migrations and test old-state upgrades. Keep control-socket paths, service modes, and local credentials out of logs and outbound text.
- Preserve local and managed modes without letting tests or CLI commands disrupt another running Link service.

Run the focused test under `test/`, then `bun run test`, `bun run typecheck`, and `bun run build`. For protocol changes, test both packages and consumers; finish with root `bun run quality:quick`.
