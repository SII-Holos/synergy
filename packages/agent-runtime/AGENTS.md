# Agent Runtime Package

Own the generic Bun host bootstrap, explicit component composition and role-specific worker entrypoints. Keep lifecycle and storage ownership in Harness, native execution in Local Runtime, and product selection in Presets. Never import optional product implementations or scan installed packages when embedding.

Require an explicit data home. Register all selected components before sealing; preserve the same module identity, selected versions and immutable installation generation in workers. Agent workers receive provider/configuration/hook contributions only; browser and media hosting remain in the foreground process. After validating pinned worker metadata, register the role’s exact selection through `RuntimeComponents` before sealing. Component removal takes effect on the next runtime start and must not discard unloaded owner data.

Tests belong under `test/` and use the shared positive isolated-home marker. Run `bun run typecheck`, `bun run test`, and root dependency/package checks. Validate separate runtimes, partial startup cleanup and real worker process readiness. Follow the root architecture, execution, persistence and testing instructions.

Select declared features before adapters and services; pin that plan in workers. Feature preferences never expand a worker composition. See [feature lifecycle](../../docs/architecture/feature-lifecycle.md).
