# channels Package

Provider-neutral Channel identity, account lifecycle, managed Projects, session routing and delivery. Required components: Local Runtime. See [owning architecture](../../docs/architecture/channels.md).

Register providers through selected owner packages. Keep CLI setup choices, configuration unions and transport startup limited to registered providers. Preserve unloaded provider configuration during selected-provider writes. Workflow commands register through named bridges; workflow descriptor presence never activates an adapter.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
