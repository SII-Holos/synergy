# agenda Package

Schedules, watches, session wakeups, delivery, indexed history and Agenda metadata. Required components: Local Runtime. See [owning architecture](../../docs/architecture/workflows.md).

GitHub polling belongs to github-agenda. Blueprint and Light Loop terminal scheduling belongs to their explicit Agenda bridges. Preserve owner-only Home scope upgrades and index consistency. Public queries and execution must exclude retained items whose explicit owners are absent; get/listStored retain owner-hidden data for reinstall and owner maintenance while applying pure record upgrades. All item readers and mutations must cross the same record-upgrade boundary before using retained Scope values. Deliveries carry their Agenda item owner requirements; execution callbacks validate retained item references before an old queue entry or Session can resume.

Expose selection through `./component`; imports are inert. Keep factory requirements, published `synergy` metadata, worker roles and production dependencies aligned. Register owner schemas, events, tools and HTTP features before Runtime composition closes.

Tests under `test/` select this owner and its real requirements. Run `bun run typecheck` and focused `bun test test/<file>.test.ts` with the package preload; then run the root dependency and installed-composition checks.
