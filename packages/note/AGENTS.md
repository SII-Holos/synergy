# note Package

Note documents, content rules, backend service, tools, routes and migrations. Expose content operations for consumers and `NoteStore.invalidateStorageIndexes()` for Home imports. Document owners register kinds through `NoteDocumentKinds`; their lifecycle updates use `NoteStore.mutateMetadata()` to preserve version, index and event semantics. Note must not own Blueprint metadata, workflow policy or prompts. Unavailable kinds are hidden from every public read and mutation, while their stored data and unknown extension fields remain intact. Independent hosts compose the package through `registerNote()` from `./register`; routes and CLI presentation are separate exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Owner public projection hooks receive a copy of their declared fields; never persist their output over canonical metadata. Lifecycle owners use `mutateMetadata` or `mutateMetadataAny` for derived fields that are absent from authoring input schemas.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.
