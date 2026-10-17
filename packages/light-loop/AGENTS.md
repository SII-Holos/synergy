# light-loop Package

Light Loop state, continuation, terminal records, and direct completion tools. Required components: Local Runtime. See [owning architecture](../../docs/architecture/workflows.md).

Own Light Loop workflow descriptors, session field upgrades and terminal migration. Keep plugin observer delivery in plugin-light-loop and Agenda wakeups in agenda-light-loop.

Keep Agenda completion guards in agenda-light-loop. Active state contains the goal and optional plugin owner/deadline; terminal records own outcomes and hook acknowledgement. Legacy review input is migration data, not a runtime branch.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
