# harness Package

Own the harness implementation and its public exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Keep optional product schemas out of the harness. `SessionSchemaRegistry` composes owner session fields, creation/import behavior and indexes; workflow state and execution/recovery policy belong to their domain packages. `ConfigExtensions` composes owner contracts; unregistered fields remain on disk and stay out of client output. Full product composition explicitly completes schema registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Register configuration and migration domains before opening `RuntimeHandle`; the process composition is locked for the process lifetime after home ownership is acquired. Migration listings are detached snapshots; use explicit registration APIs before startup. Run real runtime lifecycle suites in isolated test processes.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

- Keep concrete model SDK factories out of harness; hosts register `ProviderSdkSource`. An absent source must fail explicitly without installing SDKs.
- Keep native PTYs, filesystem watchers and OS sandbox implementations in runtime-local. Harness owns permission policy and `SandboxHost`; missing host registration must fail closed for sandboxed execution.

- Keep application-facing operations under the explicit session, scope, tools, context, lifecycle, config, persistence and rollout entries. Host adapters may use individually declared contract leaves; never export processor, resolver, scheduler or journal implementations to production. Published manifests omit `test/` exports, and production sources must not import them. Within this package use relative owner imports, not public entry points.
- File browsing, indexing, Ripgrep, Hashline editing and conflict resolution belong to runtime-local; this package retains execution read evidence and locking.
