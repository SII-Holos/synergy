# channel-github Package

GitHub Channel event polling, repository ingress, dispatch agents and tools. Required components: Channels and GitHub. See [owning architecture](../../docs/architecture/channels.md).

Keep account polling and workspace ownership in the provider lifecycle. Use GitHub public credential APIs. Agenda watches are a different selected component.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
