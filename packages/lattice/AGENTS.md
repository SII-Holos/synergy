# lattice Package

Pathways, durable Lattice runs, their state machine and BlueprintLoop coordination. Required components: Local Runtime and Blueprint. See [owning architecture](../../docs/architecture/workflows.md).

Use Blueprint loop records as execution evidence. Keep Lattice session upgrades, navigation projections and cancellation with this owner; expose StateConflict as HTTP 409.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
