# lattice Package

Pathways, durable Lattice runs, their state machine and BlueprintLoop coordination. Required components: Local Runtime and Blueprint. See [owning architecture](../../docs/architecture/workflows.md).

Use Blueprint loop records as execution evidence. Keep Lattice session upgrades, navigation projections and cancellation with this owner; expose StateConflict as HTTP 409.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Lattice is a default-off restart experiment. `./features` is pure metadata; `./maintenance` registers only data schemas and central migrations for dormant offline maintenance. Keep execution, tools and automatic advancement out of that entry. Follow [feature lifecycle](../../docs/architecture/feature-lifecycle.md).

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.

Own native Run/event/current-pointer portability, exact owner-partitioned Note selections and final epoch mutation guards. Publish paused without replaying effects. Legacy reset archives original available bytes transactionally before changing records; unsupported schemas and bindings survive and block Continue. Keep model-call deltas until their native commit receipt is acknowledged. Verify `test/transfer.test.ts`, `test/migration/lattice-v2-reset.test.ts` and store atomicity tests.
