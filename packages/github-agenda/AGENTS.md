# github-agenda Package

GitHub Agenda polling, watch preflight and selected trigger guidance. Required components: GitHub and Agenda. See [owning architecture](../../docs/architecture/workflows.md).

Register the named Agenda source explicitly. Only selected bridges add GitHub trigger inputs and instructions; native Agenda scheduling remains independent.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
