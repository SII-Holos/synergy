# agenda-light-loop Package

Agenda wake-up guidance and completion guards for Light Loop. Required components: Agenda and Light Loop. See [owning architecture](../../docs/architecture/workflows.md).

Register the explicit lifecycle bridge only. Do not load Blueprint or Note.

Stop guidance is an Agent prompt contribution requiring both loop_stop and agenda_cancel to be available and permitted. The execution guard remains independent of prompt visibility.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
