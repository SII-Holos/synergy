# Workbench

Product Projects, statistics and performance read models, activity presentation, task execution details and notifications.

Keep product read models out of core execution accounting. Session and rollout evidence remain canonical in Harness.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/workbench` from the repository root; `bun script/pack-workspace.ts packages/workbench .artifacts/packages` builds its workspace dependency closure.

Task execution queries live in `src/execution` and consume public Harness Rollout and usage exports. The scoped session API exposes summary, process/records trajectory, type-specific node detail and versioned content ranges/sections/search/download. Financial presentation is shared with statistics; formulas and immutable prices remain in Harness. Verify ownership, lifecycle, paging, grouped purposes, retained children and large content with `bun test test/execution`.

`workbench_view` presents existing Notes, Workspace files, Browser pages and immutable Assets through `src/presentation`. It does not create resources, navigate pages or perform arbitrary UI actions. Only protocol-ready, target-supporting frontends actively displaying the caller's Scope and Session are eligible. Multiple eligible frontends require an explicit returned `clientId`; no frontend is elected or broadcast to. File opens capture the caller Session's valid Workspace identity and generation, never the viewer's directory.

Presentation waits for a matching receipt from the selected connection. `applied` opens include the requested visible resource; hides confirm the known view identity as hidden. Resource identity excludes location. Content can remain `loading` after presentation is applied. The default receipt window is 30 seconds; `timeoutSeconds` accepts any positive finite duration without a product maximum. Cancellation after dispatch, active-view changes, send failure, disconnection and missing receipts leave the effect `unknown`, with cancellation sent when possible and no automatic retry.

Tool-call identities deduplicate within the Runtime and reject changed arguments. `status` with `requestId` reads only the same Scope/Session's retained confirmed receipt; without one it asks an eligible frontend for current views. Disconnect releases views and receipts, retaining only an in-memory no-replay identity tombstone until Runtime disposal. No command queue or durable state is added. Verify the real socket/tool cases with `bun test test/tool/workbench-view.test.ts` and broker failure/lifecycle units with `bun test test/presentation/service.test.ts`.
