# Decision Record: Replay only complete encrypted Codex reasoning sequences

Status: implemented

## Problem

Durable assistant reasoning parts can retain the Codex Responses item ID and encrypted payload, but model-message projection discarded both. A subsequent turn sent only visible text, losing reusable encrypted reasoning state. Older reasoning parts may have an item ID but no encrypted payload; restoring that ID unconditionally risks sending an invalid reference or depending on unavailable server-side state. The optional remote-compaction converter also dropped every reasoning item, even when the payload was present.

## Decision

Project the OpenAI reasoning item ID and encrypted content only when the producing assistant and current request have the same `openai-codex` provider and catalog model ID, and at least one part of that reasoning item has non-empty encrypted content. Keep the ID on every part of the eligible item so the locked Responses SDK can group its summaries and attach the payload, including when it arrives on the final part. Normal turn projection and the Codex remote-compaction input use this same model gate; local summarization stays on the portable, metadata-stripped path. The remote-compaction converter groups reasoning parts by item ID and excludes items without encrypted content when `store: false`.

This changes only prompt projection, not durable messages or migration: missing historical ciphertext cannot be reconstructed. Text and tool item references remain stripped, as do reasoning references for other providers, switched models, and incomplete historical items.

Prompt budgeting replaces the opaque encrypted payload with a fixed placeholder for estimation while leaving the provider-bound prompt unchanged; counting encoded ciphertext as ordinary text would cause premature compaction.

## Alternatives considered

- **Restore all OpenAI item IDs** — rejected because text and tool references can depend on server-side state that is not available for stateless requests, while old reasoning IDs without ciphertext are incomplete.
- **Strip every reasoning item and keep only readable summaries** — rejected because this is the existing loss of encrypted context for otherwise complete historical Codex reasoning.
- **Rewrite historical records to synthesize encrypted content** — rejected because ciphertext cannot be inferred from visible summaries; changing stored evidence would create false provenance.

## Consequences

Same-model Codex turns and opt-in remote compaction can reuse encrypted reasoning that is actually present in durable parts. Incomplete older records still lose this opaque state but retain their readable summaries in Synergy's history; no backfill or cross-model reuse is implied. The extra per-message scan is bounded by that message's parts. A locked-SDK fake-fetch regression checks the final `store: false` wire input and tool continuation, alongside projection and remote-compaction conversion tests.
