# agenda-light-loop Package

Agenda wake-up guidance and completion guards for Light Loop. Required components: Agenda and Light Loop. See [owning architecture](../../docs/architecture/workflows.md).

Register the explicit lifecycle bridge only. Do not load Blueprint or Note.

Wake-up instructions carry cleanup guidance for the owning session. Completion guards remain independent of prompt visibility.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
