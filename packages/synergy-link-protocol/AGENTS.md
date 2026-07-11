# Synergy Link Protocol Rules

This package owns the standalone versioned schemas and types shared by Link clients and hosts.

- Keep envelopes, identity, session, Bash, process, bridge, host, client, and error contracts transport-neutral. Do not import the Synergy runtime or Link host implementation.
- Import `z` from `zod`, derive types from schemas, reject malformed/version-incompatible input at the boundary, and preserve correlation, terminal, cancellation, and error semantics.
- Treat schema optionality and enum changes as compatibility decisions. Update Link host/client consumers and migration guidance together.
- Keep exports stable across source and built output. Do not hide behavior in a type-only declaration that runtime validation does not enforce.

Run `bun run typecheck` and `bun run build`, plus affected `packages/synergy-link` tests and root `bun run package:check` and `bun run quality:quick`. Add a real protocol test when behavior changes; do not rely on the current no-op-compatible test script as evidence.
