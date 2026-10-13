# boss-feishu Package

Boss account selection, Feishu routing, channel_push, delivery guidance and account reload. Required components: Boss and Feishu Channel. See [owning architecture](../../docs/architecture/workflows.md).

Read both owners through public exports. Only contribute delivery guidance when channel_push is actually callable. No activation based on a package merely being installed; full composition selects this bridge explicitly.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
