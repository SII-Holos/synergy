# plugin-agenda Package

Plugin Host Agenda services. Required components: Plugin Host and Agenda. See [owning architecture](../../docs/architecture/workflows.md).

Keep Plugin Host service registration and permission checks in this bridge. Agenda itself does not depend on Plugin Host.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
