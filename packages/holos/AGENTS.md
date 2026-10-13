# holos Package

Holos accounts, identity, contacts, profiles, mailbox, native tunnel and CLI integration. Required components: Local Runtime. See [owning architecture](../../docs/architecture/channels.md).

Own CLI assets under script/. Clarus borrows the tunnel only when channel-clarus is selected; notify registered account hooks without importing provider code. Model guidance requires an available session_read tool.

Own legacy Holos configuration upgrades through the Holos migration ledger. Preserve unloaded settings and unknown fields; only move known Holos fields after this owner registers, publishing explicit destination settings before retiring the source.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
