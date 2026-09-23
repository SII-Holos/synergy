# agent-integrations Package

MCP, LSP, formatting, ACP, external agent adapters and the Link client. Optional integrations register typed core sources before startup. Keep process management and protocol-specific error behavior in the owning integration. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

LSP and formatter resources follow Workspace binding generations. Formatter commands and executable probes use native process ownership, retain whole-tree write exclusion, and cancel on resource disposal. File edit events carry the committed byte version; validate it again after native admission before launching formatters. Process recovery requires a matching host and process identity plus an absent owner; a stored PID alone never permits termination. Run `bun test test/lsp test/format` for file-resource ownership changes.
