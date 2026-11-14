# Decision Record: Reconcile original machine targets through a restricted CLI

Status: implemented

## Problem

A cancelled native Handoff can retain an inactive target after its account or device loses ordinary Runtime admission. The original machine HTTP recovery owner can reconcile that target, but starting the normal member Runtime also starts unrelated execution, synchronization and recovery services. Ordinary storage bootstrap may initialize schema or resume migration before the operator has inspected the retained target.

## Decision

`org-runtime cleanup list|inspect|retire` and the independent machine executable use a restricted opener over the original enrolled Home. Bounded private stdin supplies the expected member identity, deployment incarnation and TLS CA; the original service origin, participant key and registration come from that Home. Inspection or retirement takes an exact descriptor returned by the original discovery owner. No command accepts a service signing identity, permit, plan, participant key or coordinator path.

The opener acquires the same Home process lock as an ordinary Runtime and attaches its original primary Store. List and inspect use read-only attachment. Retirement uses `TransactionalStore.openExisting`, which validates existing schema objects, current namespace format and prepared evidence projection before obtaining the normal writer fence. It does not create schema, initialize a namespace, upgrade records or schedule projection preparation. Bootstrap verifies the active manifest, configured dataset and existing database/artifact UUIDs; absence or mismatch rejects. Ordinary `open` retains its initialization behavior and PostgreSQL schema policy. The private attachment mode does not change persisted Store options or native Home identity hashes.

Local cleanup registers only the original WorkspaceMove release implementation and reads the existing workspace Host identity without creating it. Full source registration and cleanup-only registration are mutually exclusive. The opener declares real transfer readers so the original Target can validate its retained staging selection, then seals composition. It starts no ordinary member connection, Agent lifecycle, plugin host, execution provider, intake or recovery runner. Completed restored Homes must still pass the native preflight and actual SQL publication/release checks.

The returned object exposes only discovery, inspection, retirement and closure. The existing HTTP recovery owner supplies its private callback evidence to one Target controller in that context. Retirement uses the same Epoch never-activate tombstone, WorkspaceMove intent, physical token and immutable proof acknowledgement described by [the original machine recovery decision](../architecture/2026-11-13-own-revoked-target-cleanup-through-original-handoff-evidence.md). Closing stops admission, aborts and drains accepted cleanup calls, drains artifact preparation, closes storage and releases the original process lock. An unknown acknowledgement requires a later inspection; the CLI does not repeat retirement automatically.

## Alternatives considered

**Start a member Runtime with most capabilities disabled.** Normal startup still registers recovery and lifecycle services. Selectively suppressing their effects would give cleanup a second ordinary Runtime configuration to maintain.

**Treat `mustExist` as an initialization prohibition.** The ordinary writable path repairs missing SQL objects and prepares projections even when the database already exists. A controlled missing-index experiment demonstrated that side effect. The separate owning entry validates instead of repairing.

**Provide a complete source Host whose unsupported methods throw.** Such a registration would advertise preparation and capture capabilities to code that only needs release. A release-only registration expresses the actual capability.

**Allow a coordinator path in command input.** The original native coordinator is part of trusted Host composition. A user-selected path could hide the retained claim. Product commands use the canonical coordinator; isolated source tests inject their original private coordinator through a trusted command-handler factory.

## Consequences

An active ordinary Runtime keeps its Home lock and blocks this command. Cleanup does not stop that Runtime or infer that a revoked machine's physical writers have exited. Existing-only attachment rejects migrations or unfinished projections rather than repairing them. A PostgreSQL namespace whose previous writer did not release its durable ownership remains blocked by the original storage owner.

Source tests exercise the real CLI parser and handler in a subprocess with the fixture's original private coordinator. This establishes the restricted command lifecycle without allowing tests to prune unrelated global native claims. Actual PostgreSQL 18.7 schema and ownership tests verify existing-only namespace attachment, retained reads/writes, competing-writer refusal and rejection after the previous SQL owner loses its connection without releasing durable ownership. Full native PostgreSQL Home/Bootstrap restoration and installed executable acceptance with the default coordinator remain separate verification scopes.
