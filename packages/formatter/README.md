# Synergy formatter

The independently consumable formatter capability. Source ownership, composition and package distribution are described in the [package reference](../../docs/reference/packages.md).

Run `bun run typecheck` and `bun run test` from this package.

Process origins are installed by component and worker composition. Commands retain the selected resource provenance and explicit Workspace selection; see [process ownership](../../docs/decisions/implemented/architecture/2026-11-12-keep-shared-processes-under-explicit-host-origins.md). Verify `test/format/process-origin.test.ts` with the Environment fixture.
