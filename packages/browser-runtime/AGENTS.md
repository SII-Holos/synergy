# browser-runtime Package

Browser backend state, page ownership, profiles, tools, routes, installation, lifecycle, and recovery. Keep one page per session. Native WebContentsView and WebRTC/data-channel modes are both supported. Browser cleanup consumes generic session terminal events; native hosting stays in apps/desktop and shared schemas in packages/browser-core. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.
- Workspace exports use the Harness file-import Host contract, implemented by Local Runtime. Capture the Workspace generation before collecting browser data, stage bundles privately, and publish through native write admission with cancellation and qualified file events. Keep native implementations out of this package's production dependency graph.

Uploads pin the Workspace binding through dispatch, enforce actual bytes while reading, and revalidate open-handle and pathname identity. Keep shared protocol, headless staging and native-host staging behavior aligned, including zero-byte files.

Commands and idle suspension acquire the Session binding lease before the command queue. Session transitions and Workspace resource disposal close old pages before publishing new file authority, clear command replay results, and preserve owner presentation and history. Test selection, rebind, cancellation and failed Host closure with `test/workspace-lifecycle.test.ts`.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Independent hosts call `registerBrowser()` from `./register` before opening Harness, then connect `disposeBrowser()` to their runtime extension cleanup. Registration restores no page and launches no Chromium process; Browser sessions and pages remain lazy. Routes are a separate host transport contribution.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.
