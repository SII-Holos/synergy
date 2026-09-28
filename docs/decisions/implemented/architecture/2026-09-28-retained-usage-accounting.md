# Decision Record: Retain usage independently of execution archives

Status: implemented

## Problem

Message projections and session digests cannot establish installation consumption independently of loaded pages, retries, auxiliary calls, session deletion, and response retention. They also combine numeric compatibility fields with evidence that may have unknown cache splits, billing classification, or timing. A richer status bar needs a stable backend accounting contract before adding displays.

## Decision

Store compact execution facts in the existing Agent database, with stable IDs, source revisions, atomic indexes/outbox publication, retained relationships, and explicit clear suppression. Normalize provider and SDK meters once. Separate final/provisional usage, physical attempts/logical calls, billing bases/currencies, context footprint/cumulative consumption, and model generation/request/scheduling intervals.

Capture transport timing before archive/IPC delays. Retain price and billing snapshots from call admission. Migrate existing evidence in resumable background pages and preserve it before deletion or retention. Workbench serves additive typed APIs and projects the canonical totals into its existing stats shape. Frontend source and display logic stay unchanged.

The executable contract lives in [Usage accounting](../../../architecture/usage-accounting.md).

## Alternatives considered

**Keep deriving all consumption from assistant messages.** Small surface change, but it loses auxiliary requests and cannot keep retries, exact input totals, deletion, and legacy values separate. Numeric compatibility projections remain consumers, not accounting authority.

**Replay complete execution archives for every query.** Good evidence access, but query cost scales with prompts and journal updates, and archive retention would delete statistics. The retained ledger instead reads compact records and uses bounded indexed pages.

**Create a separate statistics database.** It isolates analytical queries but introduces cross-database commit and lifecycle recovery problems. The existing Agent transaction and outbox preserve one commit boundary.

**Copy an upstream turn counter or its rate formula directly.** The [DeepSeek Harness turn meter](https://github.com/deepseek-ai/deepseek-harness/blob/21638c56315ae6a2b552d6091945d3144c9af32e/packages/llm/token-meter/src/turn-usage.ts) usefully separates attempts, cumulative snapshots, and completeness. Synergy needs independent operation owners, retained history, explicit billing modes, and transport timing that excludes retry/archival delays. No upstream code is copied.

## Consequences

Deletion of a conversation and clearing usage are distinct operations. Old archives may lack timing, billing classification, or complete token evidence; migrations retain those limitations instead of applying current prices or filling unknowns with zero. Mixed/custom providers require explicit billing metadata for API-spend classification. Compatibility displays retain their existing numeric shape, while future clients can consume quality and coverage from the new API.

The ledger adds compact writes and bounded history work, not prompt duplication. Relationship and suppression metadata survive explicit clearing to prevent broken descendant attribution and resurrection. Transport and migration regressions are tested with real temporary storage, replay, rollback, deletion, streaming acknowledgement delays, and opt-in live provider calls. CI remains responsible for the cross-platform/storage matrix.

Journal gaps carry owner-level uncertainty because missing evidence cannot establish a run identity. Queries propagate that uncertainty only from selected owners and their selected descendants. Run-filtered deletion retains shared gaps so clearing one task cannot make another task's incomplete history appear complete.

Context selection uses a call-time lifecycle role rather than a built-in agent-name list, and keeps the requested owner's context separate from descendant consumption. Missing historical roles remain unknown. Compatibility totals apply progressively during historical capture; gating on completion could leave corrected data unavailable indefinitely after a rebuild failure, while mixing legacy and captured totals would risk double counting.
