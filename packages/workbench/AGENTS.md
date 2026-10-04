# workbench Package

Product Projects, statistics and performance read models, activity presentation and notifications. Keep product read models out of core execution accounting. Session, rollout and retained usage evidence remain canonical in Harness. Statistics routes and compatibility projections consume the public usage service; keep accounting formulas in that owner. Read the root AGENTS.md and the owning architecture document before changes.

File review Git comparisons and revisioned session notes belong in `src/review`. Keep comparisons read-only, fence workspace generations and content versions, and use retained Harness snapshots for historical versions. Verify `bun test test/review`, regenerate the SDK after schema changes, and follow [File review](../../docs/reference/file-review.md).

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Project directory configuration, explicit sharing and the central migration belong to `src/project/directories.ts` and `src/project/migration.ts`. Preserve Scope identity and historical Worktree sources when changing the main folder. Run `bun test test/project/directories.test.ts` for creation, revision, busy-resource, migration and multi-repository behavior.

Project task defaults belong to `src/project/task-defaults.ts` and its scoped HTTP adapter. Verify project-only writes and concurrent edits with `bun test test/project/task-defaults.test.ts`; regenerate the SDK after changing its schemas.

The managed-worktree janitor schedules per Scope and drains active sweeps during disposal. Run `bun test test/project/worktree-janitor.test.ts` for scheduler ownership changes.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.

Task execution presentation belongs in `src/execution`. Use public Harness Rollout and usage queries; keep evidence storage layouts and accounting formulas in Harness. Verify `bun test test/execution`, regenerate the SDK after schema changes, and preserve Scope/round/descendant checks, lazy content and revisioned updates.
