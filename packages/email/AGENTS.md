# email Package

Email account configuration, credentials, service, tools and HTTP operations. Required components: Local Runtime. See [owning architecture](../../docs/architecture/channels.md).

Tools and routes share the same Email service. Keep account secret redaction and restoration in the owner configuration contribution.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
