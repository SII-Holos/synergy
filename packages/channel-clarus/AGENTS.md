# channel-clarus Package

Clarus provider, account provisioning, remote Project and Task operations and deadlines. Required components: Channels, Holos and Agenda. See [owning architecture](../../docs/architecture/channels.md).

Borrow the Holos transport; never create another connection or reconnect loop. Keep provisioning migration receipts and deadline scheduling under this owner.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
