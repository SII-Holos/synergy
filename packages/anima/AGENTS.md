# anima Package

The Anima journal agent, daily Agenda seed, schedule activation and configuration reload. Required components: Local Runtime, Library, Note and Agenda. See [owning architecture](../../docs/architecture/workflows.md).

Own scheduling implementation and configuration; Library owns retrieval only. Seed and migrate only while Anima is selected. A retained paused daily item must not be duplicated on reinstall.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
