# workbench Package

Product Projects, statistics and performance read models, activity presentation and notifications. Keep product read models out of core execution accounting. Session and rollout evidence remain canonical in Harness. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

The managed-worktree janitor schedules per Scope and drains active sweeps during disposal. Run `bun test test/project/worktree-janitor.test.ts` for scheduler ownership changes.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.
