# plugin-light-loop Package

Plugin Host Light Loop services and terminal observer delivery. Required components: Plugin Host and Light Loop. See [owning architecture](../../docs/architecture/workflows.md).

Preserve generation checks and retryable terminal acknowledgments. Light Loop does not depend on Plugin Host.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
