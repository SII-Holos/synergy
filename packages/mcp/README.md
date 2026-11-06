# Synergy mcp

The independently consumable mcp capability. Source ownership, composition and package distribution are described in the [package reference](../../docs/reference/packages.md).

The component owns the shared [MCP tool access default](../../docs/architecture/execution-boundaries.md#mcp-tool-access) for Agents. Its tests cover component isolation, explicit configuration, deferred discovery and execution policy.

OAuth credentials use private, durable atomic publication so concurrent readers retain a complete login during cleanup. See the [credential publication decision](../../docs/decisions/implemented/bug-fix/2026-11-05-publish-mcp-credentials-atomically.md).

Run `bun run typecheck` and `bun run test` from this package.
