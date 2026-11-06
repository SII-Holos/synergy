# cli Package

Own the cli implementation and its public exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Storage maintenance commands own their Runtime lifecycle. Run their isolated suite with `bun test --cwd ../testing ../cli/test/cli/data-storage-command.test.ts` from this package; the package test and coverage orchestrators select the same shared preload without installing a harness Handle.

Model setup writes optional Library and Anima defaults only when their configuration domains are registered. Gate Library commands, guidance and vector endpoint probes on the same registration; reject explicit unavailable owner input before making requests. Retain unloaded owners' settings, and keep Anima activation in its own configuration domain.

Command contributions may select maintenance storage from parsed positionals; HTTP-only subcommands must not acquire the local Home lock.

Workspace and Environment commands require an attached server and explicit Scope, use generated SDK operations, and retain mutation preconditions and structured errors. Verify with `bun test test/cli/resources.test.ts`.

Own server process lifetime, managed startup reporting, signals and terminal presentation through an injected runtime factory. Keep `runCli()` as the sole parser. Agent Runtime opens the explicit composition; Harness supplies execution, and Plugin Host supplies plugin hosting when selected. Optional product domains contribute through component adapters. The CLI must not import optional product implementations. Test command-load failures and preserve send cancellation and recording-error exit codes. Poll the shared durable input projection through admission; a queued input need not have a Run record.

The public `cli/maintenance-progress` leaf owns aggregate maintenance reporting and cancellation for explicit CLI maintenance. Presets reuses its reporters; startup diagnostics stays independent of database bootstrap.

Use shared `synergy-util/terminal` and `cli-command` primitives; network and Scope host adapters belong to Local Runtime. Product branding remains here.

`createRuntimeCli` assembles core and selected component commands into the single parser. Reject namespace collisions before parsing. Nested debug, plugin-authoring and data commands enter through typed lazy adapters; embedding does not discover ambient installations. Source selection uses the same component requirements as installed composition.

Use the shared feature plan before registration. Managed readiness reports its candidate selection and active components separately. Offline maintenance accepts explicit dormant data contributions; it must not activate their services. Follow [feature lifecycle](../../docs/architecture/feature-lifecycle.md).

The installed launcher must verify its selected generation before any Harness import. All installed subprocess roles return through that launcher with the same generation digest; keep source embedding independent from ambient installation discovery. Use metadata-owned special runners instead of importing optional product implementations into the CLI.
