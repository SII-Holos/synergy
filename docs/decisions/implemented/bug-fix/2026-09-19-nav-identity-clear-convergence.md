# Decision Record: Navigation merges converge cleared session identity

Status: implemented

## Problem

A session row kept rendering a finished BlueprintLoop's glyph in the sidebar after the loop had reached a terminal state, while the composer correctly hid its BlueprintLoop indicator for the same session. One session rendered two different workflow identities at the same moment, and only a page reload made the row agree with the composer.

The backend was already correct. On a terminal loop transition `syncBoundSessionBlueprint` clears the bound session's `blueprint` fields, and the navigation projection omits the key outright rather than sending an absent value: `toNavBlueprint` returns `undefined` once every field is `undefined`, and `deriveSessionIdentity` spreads it as `...(blueprint ? { blueprint } : {})`. A live `global.nav.recent` response confirmed the wire shape — the entry carried no `blueprint` key at all while its session record read `blueprint: {}` and its loop record read `failed`.

The client could not represent that clear. `SessionNavEntry` gains `blueprint`, `workspaceType`, and `workflow` as denormalized identity, and both navigation merges treat an absent key as "no update": `applySessionToNavList` merged each identity field with `??`, and `mergeNavListByID` spread the previous entry under the incoming one. No client code ever assigned `undefined` to those fields, so a cleared binding survived in every loaded list until a reload replaced the list wholesale. The [eviction-independent session status](2026-09-18-eviction-independent-session-status.md) record named this hazard and paired the Light Loop `workflow` field with the presence of the session record in the composer, but `blueprint` and `workspaceType` were left unpaired.

## Decision

The merges express "cleared" as a distinct outcome from "unchanged", using key presence as the signal, and `navUpdateFromSession` preserves that distinction at its source. Three coordinated changes:

- `navUpdateFromSession` carries the identity keys only when it received a navigation projection. Passing `navEntry` now yields the keys even when their values are absent, while omitting `navEntry` yields no identity keys at all. The distinction matters because `session.updated` has publishers that omit `navEntry` (the rollback-acknowledgement path publishes without one), and those events carry no identity information — treating their silence as a clear would erase a live binding.
- `applySessionToNavList` assigns the projected identity keys by presence rather than by coalescing: a key present in the update is authoritative including when its value is absent, and a key absent from the update leaves the entry's value alone.
- `mergeNavListByID` clears an identity key the authoritative page omits. Every `SessionNavEntry` producer projects identity through `deriveSessionIdentity`, so a server page that omits the key is reporting a cleared binding, not an unknown one.

The single carrier-level fix covers every reader. `blueprint`, `workspaceType`, and `workflow` converge wherever a loaded entry is merged, which is what the eviction record asked for when it said a clearable field needs "the same pairing or a carrier-level fix in the merges". The composer's Light Loop pairing stays in place: it is redundant once entries converge, but it remains correct, and removing it belongs to a separate change.

## Alternatives considered

**Declare the absent key authoritative and clear it unconditionally in both merges.** The smallest possible diff — drop `??` and let absence win everywhere. It lost because `session.updated` legitimately carries no `navEntry` on some publishers, so absence is ambiguous between "cleared" and "not mentioned". Clearing unconditionally would wipe live Blueprint and worktree identity on every authorisation-related session update.

**Give the rollback-acknowledgement publisher a `navEntry` so the contract becomes unconditional.** This would let the client treat absence as authoritative in every case and remove the ambiguity at the source. It lost because the same payload drives refresh scheduling: `rootNavSectionsForSessionUpdate` and the scope-index gate read `properties.navEntry.category` and `properties.navEntry.channelType`, both `undefined` today, so populating it would change which navigation sections refresh on those events — a scheduling change hiding inside a rendering fix.

**Make the clearable identity fields `nullable` and send an explicit `null` marker.** The convention the [nullable config role clear](2026-09-19-nullable-config-role-clear.md) record established for Settings, and a true marker is unambiguous. It lost because it is the more expensive of the two: it changes the public `SessionNavEntry` schema, which forces an SDK regeneration, and the marker has to survive a nav-index rebuild migration for persisted entries. Key presence already carries the same information for free once the merge stops coalescing.

**Pair each identity field with the session record the way the Light Loop does, and reuse that pairing in the sidebar.** This is the shape the eviction record blessed, and it needs no merge change. It lost because it repeats the work per field and per surface: `blueprint`, `workspaceType`, and `workflow` would each need a record-authority helper, the sidebar's Light Loop branch would need the composer's guard promoted to shared code, and every future clearable field would repeat the exercise. Fixing the merges fixes the class.

**Have the sidebar read the session record instead of the navigation entry for workflow identity.** Would sidestep the stale entry entirely for this symptom. It lost because it reverses the eviction record's decision — the sidebar's whole point was to stop depending on a per-Scope store that eviction can drop — and it would restore the cross-store divergence for every other identity field.

## Consequences

A terminal BlueprintLoop stops painting its glyph on the sidebar at the same moment the composer drops its indicator, and a cleared workspace type or Light Loop workflow converges the same way. The invariant is now mechanical rather than field-specific: a loaded entry and the authoritative session record cannot disagree about a clearable identity field.

Costs and boundaries. Key presence is now load-bearing for three fields in both merges, so a future field must be added in all three places — the projection, the in-place merge, and the list merge — or it silently keeps the old coalescing semantics. Cursor-paginated appends still let a previously-loaded entry win over an identical id in the incoming page, so a stale entry would survive an append path in isolation; the event projection and the first-page refresh both clear it in practice, and changing which entry wins during an append is a separate ordering decision. The Cortex child-task pulse is untouched: a row spinning while a delegated child task still reports `running` is intended, and the `pulse` boolean still cannot distinguish a partial task failure from a fully running batch.

Coverage. `apps/web/test/context/layout/nav.test.ts` had no assertion for `blueprint` or `workflow`, so the invariant was unprotected. It now covers the clear through both merges, the preservation of a field the authoritative page still carries, and the guard case that an event without a projection must not clear anything.
