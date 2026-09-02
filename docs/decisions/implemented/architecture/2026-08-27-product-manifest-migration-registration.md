# Decision Record: Product manifest for domain migration registration

Status: implemented

## Problem

The central migration runner (`packages/synergy/src/migration/index.ts`) statically imported twelve domain migration modules as side-effect registrations — eight of them product domains (agenda, blueprint_loop, browser, holos, lattice, library, note, plugin_catalog) — making the L1 harness-core migration runner a compile-time dependency hub for every product domain's persisted-state upgrades. This was inversion point P8 of the harness-core layering program: the runner cannot reach R1 (core imports no product module) while those imports exist, and any new product domain had to edit the core file to be migrated.

## Decision

Split registration by layer ownership, keeping the existing self-registration protocol unchanged:

- Each domain migration file already ends with `MigrationRegistry.register(domain, migrations)`; that contract is untouched. Domains keep registering themselves on module load.
- `migration/index.ts` now side-effect imports only the four harness-core domains it owns: config, scope, session, observability.
- The eight product-domain imports moved to `src/product-registration.ts`, a new L4 manifest whose stated purpose is to be the single static list through which built-in product domains attach to the core. It is loaded first by both real entry chains: `main.ts` (CLI commands, including `acp`, `run`, and `migration` CLI paths that call `runMigrations`) and `server/runtime.ts` (which `daemon/entry.ts` also imports, covering the daemon process).
- The registry canary test (`test/migration/registry.test.ts`) now imports the manifest alongside the runner, asserting all 12 domains register; `test/holos/clarus-account-migration.test.ts` imports the holos domain migration directly, matching the existing `lattice-v2-reset.test.ts` pattern for domain-scoped tests.

Measured result: module-level L1→product edges drop from 56 to 48 (the eight migration imports), exactly the S1 budget in the layering baseline record.

## Alternatives considered

- **Registry-based migration provider API (register at runtime via a new hook)** — rejected for S1: every domain file already self-registers through `MigrationRegistry`, so the only inversion needed is where the import list lives; introducing a second registration protocol would add machinery without removing an edge.
- **Keep product imports in the runner but mark them lazy (`await import` inside `ensureMigrations`)** — rejected: dynamic imports still count as L1→product edges in the dependency graph (the analyzer and depcruise both track them) and would hide the coupling rather than invert it.
- **Manifest per entry point (CLI manifest + server manifest)** — rejected: two lists drift; the single `product-registration.ts` shared by both entry chains is the completeness guarantee the canary test locks.

## Consequences

- Any process that runs migrations without importing `main.ts` or `server/runtime.ts` (currently none exist; tests import domains directly) would miss product migrations — the registry canary and the dual-entry wiring are the guard, and later slices (continuation, tools) will reuse the same manifest so the entry-point contract stays single.
- New product domains register by adding one line to `product-registration.ts` (L4), never by touching L1.
- The migration runner's behavior, ordering, tracking, rollback, and CLI surface are byte-identical; the full `test/migration` suite (49 tests) and the holos domain suite (7 tests) pass unchanged.
