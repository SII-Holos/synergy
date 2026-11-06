# boss Package

Company hierarchy, identity, assignments, briefings and the Boss primary agent. Required components: Local Runtime, Library and Agenda. See [owning architecture](../../docs/architecture/workflows.md).

Feishu account routing belongs to boss-feishu. Note guidance and grants must come from the selected Note owner. Do not import Note or Channel providers into this package.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Boss is a default-off restart experiment declared in `./features`. `boss.enabled` controls business behavior only after assembly; it cannot opt into the module. Preserve dormant configuration and history. Follow [feature lifecycle](../../docs/architecture/feature-lifecycle.md).

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
