# server Package

Own the reusable HTTP server, core routes, transport middleware, and OpenAPI generation. Selected components register optional route contributions before the first Server.App() call. Read the root AGENTS.md and the owning architecture document before changes.

- Keep product domain routes in their owning packages and mount their explicitly selected HTTP adapters; this package depends only on harness, local-runtime, and util.
- Preserve route contribution order, Scope middleware, authentication, snapshot headers, and OpenAPI operation IDs. The global capabilities endpoint reports Runtime-owned active components. Managed processes require their captured bearer credential; never read another Runtime’s credentials or put them in readiness records.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks. Package test and coverage commands prepare the native PTY library before real WebSocket transport tests; direct test invocations require bun ../local-runtime/script/build-pty.ts first.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.
