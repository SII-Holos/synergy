# Decision Record: Compaction preserves every unprocessed history suffix

Status: implemented

## Problem

Independent compaction estimation could count encrypted reasoning as text and omit old messages before asking for a summary. A completed summary then hid all earlier history, including messages the summarizer never received. A mechanical fallback could establish the same filtering boundary without a successful model summary. Improving estimation alone cannot make these omissions safe.

## Decision

`PromptBudgeter` owns token measurement and calibration validity. Only a compatible prepared envelope and exact message prefix may reuse provider input usage; changes and restarts establish a new baseline. Preflight and fully prepared requests use the same meter, including cached input and opaque reasoning. Canonical source identities travel beside prepared messages, and `CompactionRegion` selects an oldest contiguous prefix without splitting a source or tool exchange. Selection retains a recent tail near 16% of the available history budget. A recognized context overflow halves the candidate prefix; preparation and source history remain unchanged. Failed candidates retain their evidence and never fulfill a compaction request.

A complete text-only summary must reduce the full projected context, including automatic continuation. The compaction owner verifies the entire source interval, including concurrent edits or insertions, inside the commit transaction and persists the summary with an explicit covered cursor. Subsequent recovery can combine that summary with another prefix. The cursor advances on each successful step; unprocessed messages remain available verbatim. Empty, truncated, failed, cancelled or non-shrinking summaries cannot establish coverage. An irreducible envelope fails with the last committed history intact.

History, cache and stream readers share one coverage selector. They retain canonical chronology for task control; model projection places the active summary before its remaining tail. The Session migration and import upgrader convert legacy summaries to their already-effective filtering cursors. Fork remaps coverage identities. No alternate legacy compression implementation remains.

Optional Codex remote compaction remains default off. Each remote candidate consumes the local candidate's range and is cancelled and drained when that range changes. Version-3 artifacts carry the committed covered cursor; replay requires matching producer identity and coverage and retains the root and suffix. Unbound historical artifacts remain stored but cannot replace the local summary. Root selection, steer, anchor and continuation semantics remain with their existing owners.

Serialized summary matching stops when complete assistant items reproduce the committed summary. An adjacent assistant item can belong to the uncovered suffix and must remain intact; requiring the entire consecutive assistant run to match would silently prevent remote replay. A text prefix inside one assistant item is insufficient to establish a replaceable range.

Provenance: [deepseek-harness compaction region selection](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/region.ts), revision `5badb15009ae1756c3afe0ae0cef1faafc290ccc`.

Local adaptation: Adopt prefix replacement, retained-tail budgeting, atomic tool exchanges and compression-benefit validation. Use Synergy's existing native-message meter and opaque reasoning accounting; add shrinking summary-overflow retries, durable coverage cursors and range-bound remote replay.

## Alternatives considered

**Only correct encrypted-payload estimation.** This repairs one trigger but still allows another estimation mismatch to omit unread history before summary generation.

**Stop immediately when the summary exceeds context.** This preserves history but prevents recoverable sessions from progressing when a smaller prefix would fit.

**Retain old trimming or mechanical fallback behind a switch.** Two mechanisms would preserve the original loss condition and duplicate request and persistence behavior.

## Consequences

Large recoveries can require several summary calls. A fixed envelope or smallest atomic group can still be impossible to fit; failure preserves information instead of manufacturing a boundary. The deterministic guarantee concerns which messages reach a successful summary or remain in the tail, not perfect semantic recall by a summarizing model. Existing records retain their effective behavior; migration cannot reconstruct facts already omitted from an older summary.

Tests cover provider-overflow reduction, multiple successful recovery steps, rejected output, source coverage, canonical chronology, retained tails across cache eviction and runtime restart, fork, migration/import, and unchanged anchor and remote-call lifecycles. Current implementation rules live in [LLM loop and compaction](../../../architecture/llm-loop.md#compaction).

Isolated live-provider acceptance reproduced two successive context-limit rejections before a smaller prefix succeeded, four consecutive automatic summaries, truncated output, cancellation, an invoke deadline, a provider model rejection and a source edit during generation. Each checked replacement retained every uncovered message. An encrypted-history fixture amplified ciphertext by 100 times without changing measurement or selected groups. Fork, export/import and rollback preserved the effective history; 19 session checkpoints matched after process restart. A real remote timeout preserved the committed local summary and successful continuation. Transport evidence from a smaller remote request exposed the adjacent-assistant matching defect and supplied its behavioral regression case.
