---
name: change-plugin-runtime
description: Add, modify, or review Synergy Plugin API 3 definitions, generated manifests, plugin-kit builds, installation transactions, capability approval, process runtimes, operations/events/hooks, marketplace behavior, or trusted UI contribution lifecycle.
---

# Change the Plugin Runtime

## Trace the Single Contract

1. Read [Plugin documentation](../../../docs/plugins/README.md) and the focused contract for the affected area.
2. Start with source types in `packages/plugin`, then plugin-kit build output, host discovery/install under `packages/synergy/src/plugin`, runtime generation/dispatch under `plugin-runtime`, server routes, and the Web host under `packages/app/src/plugin`.
3. Trace `definePlugin()` → generated manifest/artifacts → metadata-only validation → approval → installation transaction → contribution adapter → lazy runtime generation → invocation context/Host Service → disposer or lifecycle cleanup.
4. Load `change-execution-boundaries` for host capability enforcement, `change-server-api` for routes/SDK, `change-persistence` for lock/approval/config migration, and `develop-frontend` for the Web host.

## Preserve the Architecture

1. `definePlugin()` is the only source of identity, capabilities, contributions, and handlers. Do not add a source manifest, handler map, nested permission tree, or compatibility reader.
2. Keep plugin ID identical across manifest, registry, lockfile, approval, runtime generation, asset URL, and UI surface namespace.
3. Validate generated metadata, paths, hashes, and approval before importing executable code.
4. Keep contribution kinds flat and adapter-owned. Adding a kind means adding its public type/schema, adapter, validation, lifecycle disposal, and tests—not a branch in a central registration loop.
5. Treat generated tool input JSON Schema as canonical model metadata. Tool inputs must be top-level objects; AJV-backed execution validation must not round-trip the schema through Zod. Settings-gated tools are filtered for the current Scope and checked again at dispatch.
6. External plugins use `process`; only trusted built-ins may use `inProcess`. Do not restore worker mode or describe the process boundary as an OS sandbox.
7. One active generation is shared across enabled Scopes. Inject Scope/Session per invocation and reject stale-generation responses.
8. Expose Synergy internals only through capability-gated Host Services. Do not pass a raw SDK client, server URL, token, or mutable current Scope into plugin code.
9. Keep operations finite and schema-validated. Use declared events for invalidation; do not add a generic plugin Job or business-data store.
10. Use host-declared observer/transform/guard hook points with deterministic ordering and contribution-level degradation.
11. For trusted UI, enforce approval, UI API major, plugin-kit Solid compilation, host runtime linking, named exports, artifact hash, Scope/Session context, and one disposer per registration. Resource identity includes opaque `id/title/state`; reuse the same panel/resource tab and keep distinct resources separate. Keep themes and icons as validated, namespaced data contributions; themes use the shared structured JSON schema, never arbitrary CSS.
12. Preserve transactional install/update/remove rollback and explicit lifecycle failure semantics. Synergy must not guess how to migrate or delete plugin-owned business data.
13. Keep compiler dependencies reachable from the packaged Synergy CLI statically analyzable so Bun includes them in standalone executables. A package dependency in `node_modules` is not sufficient for runtime `require()` from `/$bunfs`.

## Verify

1. Add or update behavior tests at the owning boundary: descriptor/schema, plugin-kit build/validate/pack/sign, metadata-only discovery, approval, transaction rollback, runtime generation, operation/event/hook contract, server route, or Web registration lifecycle.
2. Cover duplicate IDs, undeclared capabilities, handler mismatch, invalid schemas/hashes, disabled Scope, timeout/cancel/crash, stale generation, trusted UI export/runtime mismatch, upgrade failure, and force uninstall when relevant.
3. Run public package typecheck/build, inspect a packed artifact, and verify a compiled standalone executable can invoke compiler-backed commands. Run focused host/Web tests, regenerate OpenAPI/SDK or config schema when their sources change, and finish with `bun run quality:quick`.
4. Update the canonical plugin docs and this Skill in the same change. Delete obsolete guidance instead of appending migration caveats to current-state docs.

## Handoff

Report public contract changes, generated artifacts, capability/approval effects, runtime/generation behavior, Host Services, operation/event/hook behavior, UI lifecycle, transaction/migration effects, tests, and docs.
