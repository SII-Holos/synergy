# Decision Record: Page organization task metadata at native checkpoints

Status: implemented

## Problem

Organization task navigation needs historical Cortex children after Runtime eviction. Loading complete child Sessions or replaying the entire shared event log for each list would admit private prompts and results or make memory grow with task history. A derived index marked complete once would omit events appended by an older service writer.

## Decision

Private task reads use the existing creator-only signed `Read.Query` dispatcher and the [native Cortex metadata index](2026-11-11-page-native-cortex-metadata-without-child-payloads.md). The native reader prepares its owning migration outside the read snapshot, pages at most 64 summaries, masks display text and rechecks the captured binding and canonical child lineage before returning. Local HTTP and remote WSS consume the same query and result.

Shared task reads select a fixed, authorized sharing-generation watermark before preparation. The organization owner maintains version pointers into its canonical shared event log, plus parent/child seek rows and a processed-sequence checkpoint. Preparation catches up through that watermark in bounded, authorized transactions. Later events extend the same index; its header never claims all future history is complete. Reading a page resolves the Session and Cortex versions at the selected watermark and excludes hidden or inconsistent children. The index owns no execution state, prompt or result body.

The generated `orgSessionTranscript.tasks` method exposes bounded metadata pages. A cursor binds the root, selected parent, sharing generation, watermark and operation. Filtered candidate windows retain a continuation even when they return no visible rows. Every read uses current object authorization; an explicitly scoped `sessions.read` API token remains subject to project and account authority. Desktop permits only the exact authenticated GET path. Existing command, decision, execution and result owners remain authoritative.

## Alternatives considered

**Page complete child records in the caller.** Materialization happens before the caller slices the list and retains unnecessary private bodies.

**Keep a second durable Task catalog.** Independent status, membership and result records would create another reconciliation authority beside native Cortex and the committed shared log.

**Prepare one current projection and reuse it for historical cursors.** Concurrent updates would change membership and task state while a fixed-watermark page sequence is still being read.

## Consequences

Native preparation can traverse historical metadata once; shared preparation can traverse an unindexed event prefix in bounded batches. Subsequent pages bound candidate work and omit full task results. Shared version pointers retain history alongside the canonical log. Task detail rendering, complete result streaming and user-interface selection remain separate consumers of these APIs.

## Verification

Real native fixtures cover metadata-only pages and binding checks; private HTTP and signed WSS return the same retained child metadata. Shared SQLite fixtures page 70 tasks, retain an old checkpoint after later updates, continue through 128 hidden candidates and reopen the same database. Mounted generated callers verify OpenAPI registration, reader and administrator visibility, foreign cursors, scoped API tokens, revocation and sharing-generation fences. Desktop authentication tests exercise the exact task-read path.
