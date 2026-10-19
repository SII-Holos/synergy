# HTTP and WebSocket Server

HTTP/WS transport, authentication, core API routes, and explicit domain route contributions. Presets registers the full API before opening Server.

Shared runtime routes stay here. Domain routes belong with the domain service and are mounted through server contributions; importing the full product from Server is forbidden.

The explicit `webApp({ directory })` component serves built Web assets. Known page paths negotiate HTML navigation before optional API handlers, after authentication, CORS and Scope resolution; JSON and fetch requests retain their API behavior. This allows a bookmarked Library page and its generated SDK endpoint to share a path.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/server` from the repository root; `bun script/pack-workspace.ts packages/server .artifacts/packages` builds its workspace dependency closure.
