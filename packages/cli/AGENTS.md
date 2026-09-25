# cli Package

Own the cli implementation and its public exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Storage maintenance commands own their Runtime lifecycle. Run their isolated suite with `bun test --cwd ../testing ../cli/test/cli/data-storage-command.test.ts` from this package; the package test and coverage orchestrators select the same shared preload without installing a harness Handle.

Own server process lifetime, managed startup reporting, signals and terminal presentation through an injected runtime factory. Keep `runCli()` as the sole parser. Presets injects command metadata, a runtime factory and nested `dataCommands`; core CLI must not import product implementation packages. Test command-load failures and preserve send cancellation and recording-error exit codes.

The public `cli/maintenance-progress` leaf owns aggregate maintenance reporting and cancellation for explicit CLI maintenance. Presets reuses its reporters; startup diagnostics stays independent of database bootstrap.

Use shared `synergy-util/terminal` and `cli-command` primitives; network and Scope host adapters belong to Local Runtime. Product branding remains here.
