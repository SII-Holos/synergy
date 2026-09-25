# Presets Package

Own authoritative preset selections and complete-product integration fixtures. Generic Bun bootstrap belongs to Agent Runtime; CLI process lifecycle belongs to CLI, and HTTP asset serving belongs to Server. Read the root [AGENTS.md](../../AGENTS.md) and [architecture ownership map](../../docs/architecture/README.md#ownership-map) before changes.

- Assemble configuration, session schemas, migrations, tools, agents, routes and services explicitly before opening the shared Harness lifecycle through `PresetRuntimeHandle`. Startup seals configuration and migration registration; late imports must not partially install a capability.
- Keep business implementations with their owning packages. Presets connects typed sources and lifecycle contributions; do not move domain algorithms into assembly or introduce package scanning.
- Preserve the single `runCli()` parser and `synergy` command. Compose the same `createRuntimeCli` component adapters as an installed host. Full-data pack, merge and move operations belong here; Library owns its SQLite merge algorithms.
- Source and compiled agent workers use Agent Runtime role entrypoints and the explicitly pinned component plan; never register the full foreground composition in workers. Preserve resource discovery, verified sandbox assets, cancellation, evidence failures and shutdown drainage.
- Keep core-only tests in Harness or Local Runtime. Full API, cross-domain lifecycle and product configuration tests belong here and explicitly register their required services.
- Preserve unloaded domain data and existing migration IDs and ledgers. Read [persistence guidance](../../.synergy/skill/change-persistence/SKILL.md) before changing upgrades, imports or data movement.
- Full-data copies hold native directory retirement claims as well as offline Home locks, including selected folders and source removal. Copied Git relationship repair belongs to Local Runtime and must never reconnect to an uncopied source.
- Preserve first-class native Desktop and WebRTC Browser presentation. Browser backend ownership belongs to `packages/browser-runtime`; protocol contracts belong to `packages/browser-core`.

Run `bun run typecheck`, affected tests and `bun run test:coverage` from this package. The shared testing orchestrator injects a positive isolated-home marker into every child; never use raw parallel coverage. Model fixtures belong to `packages/testing/fixtures/models-api.json`.

Run manual startup and CLI checks with an isolated `SYNERGY_HOME` using `develop-synergy`. Never restart or modify the active instance. For releases, verify full assets and an installed tarball outside the repository; source resolution alone cannot prove the package is complete.

Review the owning Skill for CLI, persistence, execution, API, Browser or Channel changes. Regenerate API contracts with the root `./script/generate.ts` and command documentation with `bun script/gen/gen-cli-reference.ts` when those public contracts change.

`bun run build` compiles workspace modules into `dist/modules`. Use the package-owned `bun script/build.ts --single --skip-install` for a local executable; release tooling selects its target matrix through that same explicit binary entry.

`src/catalog.ts` owns declarative core/full/Web/Desktop package selections. Full includes backend components, HTTP and authoring tools; Web adds the application payload and Desktop adds its signed shell. `dataManagement()` contributes cross-domain data commands through the same component API. Source development also selects the local Web assets explicitly.
