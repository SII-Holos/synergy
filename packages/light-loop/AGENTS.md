# light-loop Package

Light Loop state, continuation, terminal records, tools and its host-selected reviewer. Required components: Local Runtime. See [owning architecture](../../docs/architecture/workflows.md).

Own Light Loop workflow descriptors, session field upgrades and reviewer prompts. Keep plugin observer delivery in plugin-light-loop and Agenda wakeups in agenda-light-loop.

The reviewer must not assume optional evidence tools. Media, Code Tools and Browser supply their own grants after selection; explicit user denials remain authoritative. Keep Agenda stop guidance in agenda-light-loop rather than the standalone tool description.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
