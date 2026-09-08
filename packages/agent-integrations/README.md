# Agent Integrations

MCP, LSP, formatting, ACP, external agent adapters and the Link client.

Optional integrations register typed core sources before startup. Keep process management and protocol-specific error behavior in the owning integration.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/agent-integrations` from the repository root; `bun script/pack-workspace.ts packages/agent-integrations .artifacts/packages` builds its workspace dependency closure.
