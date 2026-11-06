# channel-feishu Package

Feishu accounts, transport, messages, streaming, cards, setup, provider tools, availability policy and intent-closing loop jobs. Component and Agent worker tool registration share `src/tools.ts`. Required components: Channels. See [owning architecture](../../docs/architecture/channels.md).

Own SVG raster worker, fonts and notices under script/ and published dist/lib/resvg-wasm. Boss routing is an explicit boss-feishu bridge; do not activate it from the provider.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
