# Decision Record: Restore Session Tag Persistence and Navigation

Status: implemented

## Problem

Session tags were incomplete across persistence, navigation, listing, and HTTP creation paths. The create input type accepted tags, but owner schema composition did not include the harness base field in a new `Session.Info`. Incremental navigation entries could omit tags even though rebuilt navigation indexes projected them. Session listing lacked a public tag constraint, and `POST /session` removed tag fields before invoking the harness create operation.

Historical navigation indexes stored before these fixes also lacked the derived tag projection, so persisted tags were not guaranteed to be discoverable after upgrade.

## Decision

`Session.create()` writes canonical tags by normalizing each submitted value: trim surrounding whitespace, remove empty values, and remove exact duplicates. The same bounded array schema supports tags on `Session.Info`, create requests, patches, navigation entries, and listing responses.

`Session.toNavEntry()` projects the canonical tag array into every incremental navigation update. A derived-session migration rebuilds navigation indexes for all scopes from canonical session info so historical indexes receive tags without changing session records.

`Session.list({ tag })` accepts an exact tag value, reads canonical session info for affected scope entries, applies the membership constraint before filtering, offset, and limit selection, and then resolves the selected sessions into client-visible results.

`POST /session` accepts `tags` through its request schema and passes the field through to `Session.create()`. OpenAPI and generated SDK request types are regenerated from the server contract.

Existing Web UI interactions continue to submit the complete resulting tag array on patch. Navigation routes apply exact tag filters before cursor pagination, so totals and returned pages describe the filtered result.

## Alternatives considered

- **Add tags only to the display model.** Rejected because navigation consumers and persisted session metadata must share the same canonical field or results diverge after reload and index rebuild.
- **Treat tags as owner-derived fields only.** Rejected because tags belong to the harness-owned base session contract and must be available even when no owner contributes the field during creation.
- **Filter only the resolved window.** Rejected because cursor totals and pagination boundaries would describe the unfiltered set and violate the documented filter behavior.
- **Repair stale indexes during every read.** Rejected because a registered derived migration provides idempotent startup recovery and keeps request-time navigation reads deterministic.
- **Maintain a client-side tag cache as the filter source.** Rejected because canonical session info and rebuilt navigation indexes remain the durable source of truth across scopes and restarts.

## Consequences

New sessions created through the harness or `POST /session` preserve normalized tags immediately.

Existing sessions with canonical tags recover tag-bearing navigation entries after the derived migration rebuilds affected indexes.

Incremental create and update paths project tags consistently with navigation index rebuilds.

Tag filters return sessions across the complete filtered result set before offset and limit are applied; listing reads additional canonical session info only for the constrained candidate entries.

The persisted `Session.Info` remains unchanged by index recovery, and no separate tag entity or mutation lifecycle is introduced.

SDK callers receive typed create, update, navigation-entry, and tag-query fields after contract generation.
