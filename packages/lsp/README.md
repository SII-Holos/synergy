# Synergy lsp

The independently consumable lsp capability. Source ownership, composition and package distribution are described in the [package reference](../../docs/reference/packages.md).

Run `bun run typecheck` and `bun run test` from this package.

Shared servers use composition-owned Host origins after validating the originating resource frame through preparation. Their accepted lifetime is independent of that Task; see [process ownership](../../docs/decisions/implemented/architecture/2026-11-12-keep-shared-processes-under-explicit-host-origins.md). Verify `test/lsp/process-origin.test.ts` with the native process and Environment fixtures.
