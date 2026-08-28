# Decision Record: Global session search reads nav indexes instead of per-session info files

Status: implemented

## Problem

`GET /global/session` (`global.session.search`) — the backend for the Web global search modal (Cmd/Ctrl+K) and the archived-sessions panel — loaded every candidate session's info JSON on every request: for each scope it read the page index, then issued one serial `Storage.read(sessionInfo)` per entry before filtering by title in memory. A user with hundreds of sessions paid hundreds of serial file reads per keystroke (after 250 ms debounce), almost all discarded by the `limit` slice. Title search also ranked purely by `time.updated`, so a deep substring match could outrank an obvious prefix match, and the response's `sortBy=created` / `sortBy=archived` sort keys required the info files precisely because no index carried those timestamps.

## Decision

The route now aggregates `session_nav_v2` scope indexes (`SessionNav.readNavIndex`, one read per scope, issued in parallel) and applies archived / parentOnly / title filtering plus all sorting entirely on the in-memory entries. Session info files are read only for the returned page (`Storage.readMany` on the ≤ limit slice) to supply `lastExchange` previews and authoritative titles. `SessionNavEntry` gains optional `createdAt` / `archivedAt` fields, filled by `toNavEntry` on every session mutation path and by `buildNavIndexUnlocked` on rebuild; migration `20260828-session-nav-timestamps` rebuilds all nav indexes to backfill them, and the route lazily backfills missing timestamps from info files when it encounters a legacy index that predates the fields. When `search` is present and the caller did not explicitly pass `sortBy`, results are ranked prefix match > word-boundary match > substring match (recency as tiebreaker); every explicit sort behaves exactly as before. The response schema is byte-identical to the previous implementation.

## Alternatives considered

**Extend the page index with title and timestamps instead of using nav indexes.** The page index deliberately carries only ordering keys; adding title plus two timestamps would create a second per-scope index that duplicates what `session_nav_v2` already maintains (title, archived, parentID, pinned, activity) with full incremental coverage on create/update/archive/remove and lazy rebuild. Two overlapping indexes on the same lifecycle is strictly more maintenance for no capability gain.

**Keep the current shape but batch the info reads (`readMany`).** Batching removes the serial-await cost but still reads and discards every non-matching session's info on every keystroke — O(N) reads per request regardless of `limit`. It fixes the constant, not the complexity.

**Introduce SQLite FTS (or a trigram/inverted index) for search.** No such subsystem exists in the storage layer today, and title-substring search does not need it. This option remains the right answer if message-content search later becomes an HTTP surface, but it is out of proportion for the title-search path this change fixes.

## Consequences

Search requests now cost one parallel nav-index read per scope plus ≤ limit info reads, instead of one info read per candidate session; the nav index — already load-bearing for the sidebar — additionally backs global search, so its correctness guarantees are shared rather than new. Legacy indexes lacking the new timestamps pay a one-time info-read backfill on first request until the migration rebuilds them, after which the fields come entirely from the index. `archivedAt` reuse of the stored `time.archived` value (0 restores to unarchived) keeps the restore path consistent with the archived filter's existing semantics. Relevance ranking changes result order only for `search` requests without an explicit `sortBy`; consumers that always pass `sortBy` (the archived-sessions panel) see no difference. The `Session.list` search branch retains its full `readMany` scan for now — it serves only the SDK/CLI surface and is a candidate for the same treatment in a follow-up.
