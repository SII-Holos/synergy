# Boss

Boss owns a worker tree built from native Sessions and Inbox assignments and reports. It has no separate task ledger. See [Workflows](../../docs/architecture/workflows.md).

The `./maintenance` entry registers the stored Session schema and versioned transfer proof owner. Hosts can preserve and import history without selecting private context providers. Maintenance supplies no workflow execution capability; native Continue still requires a real Boss workflow owner.

The full `boss()` component selects Local Runtime, Library and Agenda, then registers prompts, agents, orchestration and reload behavior. Its runtime context and periodic briefing belong to that explicit composition.

Focused verification: `bun test test/maintenance.test.ts` and `bun run typecheck`.
