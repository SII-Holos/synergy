# Product Runtime Package

Own the complete product composition and packaged runtime entry. Read the root [AGENTS.md](../../AGENTS.md) and [architecture ownership map](../../docs/architecture/README.md#ownership-map) before changes.

- Assemble configuration, session schemas, migrations, tools, agents, routes and services explicitly before opening the shared Harness lifecycle. Startup seals configuration and migration registration; late imports must not partially install a capability.
- Keep business implementations with their owning packages. Product Runtime connects typed sources and lifecycle contributions; do not move domain algorithms into assembly or introduce package scanning.
- Preserve the single `runCli()` parser and `synergy` command. Inject the product runtime factory, command catalog, default server command and nested Data contributions. Full-data pack, merge and move operations belong here; Library owns its SQLite merge algorithms.
- Source and compiled agent workers must install the same full composition as the foreground runtime before starting the Harness runner. Preserve resource discovery, verified sandbox assets, cancellation, evidence failures and shutdown drainage.
- Keep core-only tests in Harness or Runtime Local. Full API, cross-domain lifecycle and product configuration tests belong here and explicitly register their required services.
- Preserve unloaded domain data and existing migration IDs and ledgers. Read [persistence guidance](../../.synergy/skill/change-persistence/SKILL.md) before changing upgrades, imports or data movement.
- Preserve first-class native Desktop and WebRTC Browser presentation. Browser backend ownership belongs to `packages/browser-runtime`; protocol contracts belong to `packages/browser`.

Run `bun run typecheck`, affected tests and `bun run test:coverage` from this package. The shared testing orchestrator injects a positive isolated-home marker into every child; never use raw parallel coverage. Model fixtures belong to `packages/testing/fixtures/models-api.json`.

Run manual startup and CLI checks with an isolated `SYNERGY_HOME` using `develop-synergy`. Never restart or modify the active instance. For releases, verify full assets and an installed tarball outside the repository; source resolution alone cannot prove the package is complete.

Review the owning Skill for CLI, persistence, execution, API, Browser or Channel changes. Regenerate API contracts with the root `./script/generate.ts` and command documentation with `bun script/gen/gen-cli-reference.ts` when those public contracts change.
