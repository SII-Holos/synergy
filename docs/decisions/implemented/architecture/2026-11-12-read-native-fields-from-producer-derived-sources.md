# Decision Record: Read native fields from producer-derived sources

Status: implemented

## Problem

A small private tool-header request read and decoded its complete canonical Part before removing input and output. Its intermediate header still retained the attachment array and arbitrary metadata. Each field range repeated that read, including after its field cache was ready. Memory therefore grew with unrelated producer bodies despite bounded HTTP responses.

## Decision

`PartContent.replace()` and streaming checkpoint publication maintain `SessionPartFieldSource` in the canonical writing transaction. Capture reads the just-written record once to derive from its actual JSON normalization. It never runs a producer's potentially stateful `toJSON` again. The derived projection binds the exact Part revision, a bounded presentation header and field sources. Ordinary descriptor, version and range reads use that projection; a missing or incompatible projection never triggers a full-Part read or repair.

Canonical input, raw JSON, errors and static text use fixed 16 KiB UTF8 source rows with exact byte counts and digests. Large values serialize incrementally from the admitted producer. Known immutable Rollout inputs and outputs use compact artifact locators, preserving their owner and complete or partial provenance. Streaming text retains its native checkpoint references and the existing cancellable preparation queue. Ready chunk and artifact sources seek directly; preparation remains explicit where a descriptor still requires materialization.

The header contains only the fields required for presentation. Tool metadata projects a finite scalar selection; it cannot carry its original nested objects or lifetime attachment collection. These limits affect presentation, not canonical producer storage or the retained original field bytes. The canonical Part and explicit complete-Part reader preserve unknown fields and complete metadata. An unrepresentable header is explicitly unavailable instead of replacing the producer with a truncated object.

A running Part can precede original tool admission. Its canonical execution input may already differ from the model's envelope. The field-source projection retains that canonical fallback and a compact native tool locator. The existing `RolloutToolPartIndex` projects bounded original-input metadata beside its canonical execution record. Foreground input resolution reads this metadata instead of opening the complete execution record, whose error can also be large. Native versions include the resolved source manifest as well as the Part revision, so later admission changes the version without inventing a Part write. Range reads repeat that check after awaited I/O.

Central Session migration prepares historical field sources once. Each existing 32-key migration page publishes its pending derived fields through one original writer transaction. It reads and decodes each canonical Part serially inside that writer, preserving revision checks and fixed-size field chunks instead of retaining a page of full bodies. A rejected page rolls back its derived fields while earlier pages remain committed; retry rechecks their current projections and does not rewrite canonical producers. Input-index format 2 upgrades through its owning Session and operation migrations from canonical tool records; ordinary compact reads do not adopt format-1 rows. Completion metadata avoids repeating a completed current-format rebuild. Fresh field projections at the canonical revision skip body scans; unknown projection versions fail without rewriting them.

Portable Core excludes field-source rows and native tool-input indexes. The target rebuilds its tool index after canonical records and artifacts are published, then derives field sources under the same activation transaction. This order preserves original Rollout arguments when canonical Part input is a normalized display value. Source SQL revisions and injected derived references cannot authorize target reads.

## Alternatives considered

**Remove attachments only from the returned header.** The Runtime would still parse and retain complete canonical input, metadata and attachments before projecting them.

**Prepare the missing index during an ordinary read.** This makes a small request perform unbounded historical work and creates a second upgrade path.

**Freeze the input source when the Part is written.** Original tool admission can arrive later, leaving a running Part bound to its normalized input instead of the retained model envelope.

**Resolve every input from its full tool execution record.** That record can contain a large error; replacing one full-body read with another does not bound header residency.

## Consequences

The producer writes derived source metadata and fixed rows for fields without an existing immutable artifact. Capture incurs one complete canonical decode during the owning write; large tool Parts therefore retain work proportional to their size in that phase, while streaming text records retain their small checkpoint representation. Canonical data remains intact, while ordinary header and field-window work is independent of its full Part size. The central upgrade and target activation perform complete producer reads under their existing owning lifetimes.

Real Storage tests forbid canonical Part reads during eager descriptors and byte windows, retain 1,001 attachment entries and large metadata, exercise UTF8 boundaries, boxed primitives, omitted JSON values and stateful `toJSON`, and verify transactional rollback, restart and unknown-format refusal. A later-admission case forbids both full Part and execution-record reads while changing the resolved input version. The two-Home Core fixture changes target revisions, rejects injected derived rows and retrieves the original model envelope rather than its different normalized Part input.

## Related

- [Private native reads](2026-11-11-read-private-sessions-through-bounded-native-contracts.md)
- [Paged tool attachment metadata](2026-11-12-page-tool-attachments-by-canonical-producer-revision.md)
