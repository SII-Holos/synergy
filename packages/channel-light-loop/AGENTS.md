# channel-light-loop Package

Own the explicit Channels command adapter for light-loop. Required components: Channels and light-loop. See [Channels architecture](../../docs/architecture/channels.md).

Only selecting this bridge registers its commands and help entries. Importing either domain or registering its workflow descriptor must not enable Channel integration. Keep worker and in-process registration equivalent.

Expose selection through `./component`; use public exports from both owners. Tests live under `test/`. Run focused `bun test test/selection.test.ts`, `bun run typecheck`, and the root dependency and installed-composition checks.
