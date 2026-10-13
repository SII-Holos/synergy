# blueprint Package

Plan, Blueprint Note document kind, BlueprintLoop, recovery and the host-selected supervisor. Required components: Local Runtime and Note. See [owning architecture](../../docs/architecture/workflows.md).

Register NoteDocumentKinds before schemas seal. Own Blueprint metadata, mutation policy, session access and migration receipts. Do not register other Note kinds or require Library. Lattice coordinates through public APIs.

Public Session bindings and Note run metadata require a selected loop source. Derive legacy source fields only from matching stored loops; unknown orphan bindings stay hidden. Keep binding catch-up on metadata access, and control-message/part/Inbox catch-up behind explicit Session history admission. Preserve canonical data and refresh existing display projections in the same control-migration transaction.

Gate loop access and execution by the Runtime-registered source owner. Raw loop access is reserved for migration and non-destructive recovery accounting. Preserve absent-source records and project their Session/Note bindings only with proven source metadata; verify partial removal and reinstall while Blueprint remains selected.

Supervisor permissions and prompts must not assume optional evidence tools. Media, Code Tools and Browser supply their own grants after selection; explicit user denials remain authoritative. Agenda stop guidance and guards belong to agenda-blueprint.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
