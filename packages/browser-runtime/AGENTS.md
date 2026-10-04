# browser-runtime Package

Desktop Browser backend state, page collections, persistent identities, authorization, tools, routes, lifecycle and recovery. Every command targets a page; user selection is presentation state. Browser cleanup consumes generic session terminal events; native hosting stays in apps/desktop and shared schemas in packages/browser-core. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.
- Workspace exports use the Harness file-import Host contract, implemented by Local Runtime. Capture the Workspace generation before collecting browser data, stage bundles privately, and publish through native write admission with cancellation and qualified file events. Keep native implementations out of this package's production dependency graph.

Uploads pin the Workspace binding through dispatch, enforce actual bytes while reading, and revalidate open-handle and pathname identity. Keep shared protocol and native staging behavior aligned, including zero-byte files.

Agent commands acquire the initiating Session binding lease before the page queue, retaining its Environment, Workspace generation and permissions. Ordinary Scope-owned pages have no filesystem binding and survive task cancellation, completion and Workspace transitions. Session-bound local and historical pages close before a binding change publishes file authority. Include the initiating Session in command identities and activity events; cancellation must not clear another task’s operation. Test selection, rebind, cancellation and failed Host closure with `test/workspace-lifecycle.test.ts`.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Independent hosts call `registerBrowser()` from `./register` before opening Harness, then connect `disposeBrowser()` to their runtime extension cleanup. Registration restores no page and launches no Chromium process; Browser sessions and pages remain lazy. Routes are a separate host transport contribution.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.

Production uses the local Desktop broker only. Playwright Core is a test-only development dependency for controller conformance fixtures; never publish its execution transport or install a separate browser engine.
