# workflows Package

Blueprint, Light Loop, Lattice, Agenda, Boss and their commands, tools, routes and migrations. Declare required knowledge, project, automation and content services. Missing services must fail explicitly; do not quietly present a partial workflow as complete. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own session domain schemas and creation/import behavior in `src/session-schema.ts`. Register legacy workflow session migrations from `src/session-migration.ts`; their IDs and `session` tracking ledger stay unchanged while unloaded owners leave them untouched.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- GitHub watch policy and Boss Channel accounts arrive through `GithubWatchPolicy.register()` and `BossRuntime.registerAccountSource()`. Product composition connects the Connections-owned readers; do not read foreign configuration fields through global type augmentation. Missing required services must remain explicit errors.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.
