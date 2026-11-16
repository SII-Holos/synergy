# Lattice

Lattice coordinates requirements, Pathways and BlueprintLoop execution using native durable runs and events. It is an experimental component, disabled until explicitly selected at restart. Its maintenance entry retains schemas and migrations without enabling tools or automatic advancement.

Session handoff retains terminal and current runs, events, pending effects and exact Note versions through private staging. Activation keeps work paused; independent Continue requires the selected execution owner and current epoch authority. Unsupported stored schemas remain intact and block continuation until a compatible owner is available.

The legacy reset migration preserves original available records in a paged immutable archive before changing bindings. It cannot reconstruct content removed by an older release. Model-call flushes use native commit receipts so an acknowledgement retry does not duplicate usage.

Run `bun run typecheck` and focused `bun test test/transfer.test.ts test/migration/lattice-v2-reset.test.ts test/lattice/store.test.ts test/lattice/storage-atomicity.test.ts` from this package. See [workflow architecture](../../docs/architecture/workflows.md).
