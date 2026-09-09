# HTTP and WebSocket Server

HTTP/WS transport, authentication, core API routes, and explicit domain route contributions. Product Runtime registers the full API before opening Server.

Core routes stay here. Domain routes belong with the domain service and are mounted through server contributions; importing the full product from Server is forbidden.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/server` from the repository root; `bun script/pack-workspace.ts packages/server .artifacts/packages` builds its workspace dependency closure.
