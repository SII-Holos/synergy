# github Package

GitHub identity, authentication, connected account configuration and routes. Required components: Local Runtime. See [owning architecture](../../docs/architecture/channels.md).

Repository Channel polling belongs to channel-github; Agenda trigger polling belongs to github-agenda. Loading credentials must not activate either consumer.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
