# Decision Record: Replay only complete encrypted Codex reasoning sequences

Status: implemented

## Problem

Durable assistant reasoning parts can retain the Codex Responses item ID and encrypted payload, but model-message projection discarded both. A subsequent turn sent only visible text, losing reusable encrypted reasoning state. Older reasoning parts may have an item ID but no encrypted payload; restoring that ID unconditionally risks sending an invalid reference or depending on unavailable server-side state. The optional remote-compaction converter also dropped every reasoning item, even when the payload was present.

## Decision

Project the OpenAI reasoning item ID and encrypted content only when the producing assistant and current request have the same canonical `openai-codex` profile, connection provider ID, and wire API model ID, and at least one part of that reasoning item has non-empty encrypted content. The catalog model ID alone cannot establish wire compatibility, and a named connection's provider ID alone cannot establish its canonical profile. Keep the ID on every part of the eligible item so the locked Responses SDK can group its summaries and attach the payload, including when it arrives on the final part. Normal turn projection and Codex remote-compaction input and artifact replay use the same identity and ciphertext gate; local summaries remain portable.

This adds optional producer profile and API model identity to new durable assistant messages without backfilling old messages: missing identity or ciphertext in historical records cannot be reconstructed. Text and tool item references remain stripped, as do reasoning references for switched connections or wire models and incomplete historical items.

When calibration is unavailable, prompt budgeting replaces opaque encrypted bytes with a placeholder and charges each projected reasoning item using the producing assistant's reported reasoning usage (falling back to output usage when reasoning usage is absent), bounded below by a conservative per-item estimate. Ciphertext size is not a token count; neither an uncalibrated fixed placeholder alone nor byte-count tokenization reliably accounts for long encrypted reasoning.

## Alternatives considered

- **Restore all OpenAI item IDs** — rejected because text and tool references can depend on server-side state that is not available for stateless requests, while old reasoning IDs without ciphertext are incomplete.
- **Strip every reasoning item and keep only readable summaries** — rejected because this is the existing loss of encrypted context for otherwise complete historical Codex reasoning.
- **Rewrite historical records to synthesize encrypted content** — rejected because ciphertext cannot be inferred from visible summaries; changing stored evidence would create false provenance.

## Consequences

Compatible Codex turns and opt-in remote compaction can reuse encrypted reasoning whose identity and payload were durably recorded. Incomplete or unidentifiable older records retain readable summaries without encrypted replay or backfill. Prompt measurement traverses the projected items, so removed reasoning does not consume usage allowance; producer usage is divided across the encrypted items of its assistant message because the provider reports aggregate reasoning usage rather than per-item counts. A locked-SDK fake-fetch regression checks the final `store: false` wire input and tool continuation, alongside projection and remote-compaction conversion tests.
