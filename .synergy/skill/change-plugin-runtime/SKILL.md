---
name: change-plugin-runtime
description: Add, modify, or review Synergy's public plugin manifest/SDK, plugin-kit build and packaging, installation transaction, signatures and trust, approval and capability ceilings, runtime mode/isolation, host bridge and hooks, marketplace, or Web UI contribution lifecycle. Use across packages/plugin, plugin-kit, synergy plugin/plugin-runtime/server routes, app plugin host, and UI registries.
---

# Change the Plugin Runtime

## Trace the Public-to-Host Contract

1. Read [Plugin documentation](../../../docs/plugins/README.md), then the relevant manifest, runtime/permissions, security, tool/delegation, or UI-contribution document.
2. Start with the public schema and types in `packages/plugin`, authoring/build behavior in `packages/plugin-kit`, host installation/runtime ownership in `packages/synergy/src/plugin` and `plugin-runtime`, server contracts, and Web host registries/lifecycle under `packages/app/src/plugin`.
3. Trace manifest declaration → validation → resolved artifact/path → signature/trust → approval hash/diff → installation transaction and lockfile → runtime mode/process/worker → host bridge/hooks → UI contribution loading and disposer.
4. Load `change-execution-boundaries` for capabilities/approval, `change-server-api` for routes/SDK, `change-persistence` for lock/approval/audit/runtime state, `add-tool` for first-party tool presentation, and `develop-frontend` for built-in host UI.

## Preserve Plugin Boundaries

1. Keep public packages independent from private runtime modules. A plugin imports the published SDK; the host may consume the public contract, never the reverse.
2. Keep plugin IDs consistent across manifest, resolved spec, artifact, lockfile, approval, audit, runtime state, bridge namespace, asset URL, and Web surface IDs.
3. Validate and approve the declared capability ceiling before importing executable code. Effective runtime permissions may narrow that ceiling but must not silently exceed it.
4. Preserve transactional install/update rollback across staged artifacts, signature and trust checks, approval, lockfile/registry writes, runtime start, audit, and failure cleanup.
5. Keep in-process, worker, and process runtime modes explicit. Preserve supervisor health, timeouts, logs, bridge method allowlists, failure isolation, and removal/reload cleanup.
6. Namespace plugin config, auth, cache, tools, hooks, assets, commands, and UI surfaces. Keep credentials out of config, logs, bundles, diagnostics, and browser-local storage.
7. For UI contributions, enforce UI API-major compatibility, shared Solid externalization, named exports, asset packaging, declarative fallbacks, host-owned accessibility/layout, and one disposer per registration. Built-in host UI uses semantic icons; plugin-declared icons stay in the plugin icon registry.
8. Theme contributions are packaged structured JSON themes with light/dark seeds and typed canonical-token overrides. Validate them through the shared theme schema and resolver; do not load arbitrary CSS as a product theme. Keep plugin-kit scaffolds, copied assets, host registration, and migration guidance aligned.

## Verify and Publish Contracts

1. Write the failing test at the owning boundary: public schema, plugin-kit validation/build/pack, installation transaction, consent diff, capability consistency, runtime host/bridge, server route, or Web registry lifecycle.
2. Test upgrade and rollback, invalid signatures/artifacts, approval changes, duplicate IDs, mode fallback, crash/restart, bridge denial, missing UI exports, reload disposal, and uninstall cleanup where relevant.
3. Build and typecheck the public plugin and plugin-kit packages; inspect packed artifacts rather than relying on source layout. Run focused host/runtime/server/Web tests and `bun run quality:quick`.
4. Update public plugin docs and migration guidance in the same change. Regenerate SDK/OpenAPI only when host routes or visible schemas change.

## Handoff

Report public schema/API effects, ID and capability consistency, trust/approval behavior, transaction and rollback, runtime isolation/bridge, UI lifecycle, package artifacts, migrations, tests, and documentation updated.
