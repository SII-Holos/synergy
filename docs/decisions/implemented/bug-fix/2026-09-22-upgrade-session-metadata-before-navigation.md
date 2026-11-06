# Decision Record: Upgrade Session metadata before navigation reconstruction

Status: implemented

## Problem

Session workspace bindings upgrade lazily through `SessionRecords`, while navigation reconstruction validated raw storage against the current Session schema. Historical embedded Scope metadata lacked the required local binding and was omitted from the index. Recording the navigation migration as complete preserved the empty result across subsequent starts even when individual Sessions later upgraded successfully.

## Decision

Navigation reconstruction uses the canonical Session reader before validation. Registered metadata upgrades and owner receipts join the index transaction. Invalid historical records retain the existing skip behavior with schema issue paths and codes; storage and upgrade failures propagate. No message hydration, activity update or whole-store conversion is involved.

The derived migration `20260922-session-nav-workspace-binding` rebuilds existing navigation after the workspace-binding migration is registered. Its owner-local callback upgrades and indexes only the admitted Session, preserving deferred import. The Runtime startup regression begins with historical metadata, an already completed navigation receipt and persisted empty indexes, then closes and reopens the same isolated store.

## Alternatives considered

**Repair only one installation.** An operational database edit would leave every other affected installation broken and would not exercise the supported upgrade path.

**Change only the existing navigation migration.** Installations that recorded its completion would continue serving the persisted empty index. A new versioned migration is required.

**Accept the old Scope schema in navigation.** A second compatibility parser would diverge from the registered owner migration and leave canonical metadata unconverted.

## Consequences

The first repaired startup performs a metadata and navigation pass over published Sessions. Later starts use its completion receipt. Conversation activity, archived state, lineage, tags, unknown owner fields and message evidence remain unchanged. Deferred history stays deferred until admitted. The [regression suite](../../../../packages/harness/test/session/nav-upgrade.test.ts) covers reconstruction, normal startup, mixed owner receipts and rollback; the [incident report](../../../postmortem/0025-lazy-session-upgrade-emptied-navigation.md) records the missed interaction.
