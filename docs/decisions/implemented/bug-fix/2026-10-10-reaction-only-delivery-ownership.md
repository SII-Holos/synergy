# Decision Record: Reaction-only delivery ownership and uncertain attempts

Status: implemented

## Problem

The [reaction-only feature](../feature/2026-09-28-feishu-reaction-only-terminal.md) promises exclusive delivery, but root-wide intent lookup can discard a later ordinary answer or convert a repeated intent into a text or attachment reply. A foreground inbox drain can also finish multiple roots and return another root's terminal, while the foreground streaming session still owns its original root. Finally, recording only after an external reaction leaves a duplicate-dispatch window if local confirmation fails or the process exits.

## Decision

- `reaction-only-runtime.ts` classifies the selected terminal assistant's completed tool intent independently from reaction idempotency. Error assistants are not successful reaction terminals. Later ordinary terminals can reply normally; another intent-bearing terminal under an attempted or resolved root remains silent.
- Foreground delivery in `channel/index.ts` processes every newly completed terminal for its own accepted root in order, rather than using the inbox drain's last result or only its root's last terminal. Earlier ordinary answers retain their delivery responsibility when a later steer chooses reaction-only. Live text and tool progress, each terminal's transcript, and attachment projection retain that root and terminal boundary. A later queued root's error cannot convert an already-completed foreground reaction intent into an error-text reply. Other queued roots remain the outbound bridge's responsibility. Compensating delivery in `outbound-parts.ts` uses the same intent classification and reaction executor.
- Shared task-message projection excludes assistant segments ending in an earlier reaction-only terminal. Suppressed artifacts and response cards remain private when a later ordinary continuation replies; ordinary segments retain attachment delivery and retry records.
- Delivery failures are contained by the terminal that owns them. A failed earlier ordinary compensation cannot skip a later reaction-only terminal or fall into an aggregate root-transcript error reply. Ordinary no-answer fallback retains non-terminal text only within the current generation segment, after the preceding terminal boundary.
- If post-invoke terminal history cannot be read, delivery fails closed without emitting the unclassified aggregate transcript. Channel core invokes the required `StreamingSession.closeWithoutDelivery()` operation, not terminal-delivery `close()`: Feishu serializes only a streaming-mode settings close with an empty summary, skips cached answer/tool rendering and image materialization, and never invokes text fallback. Confirmed terminal cards clear their existing persisted state; rejected cleanup retains it for existing settings-only recovery. Core releases foreground ownership and event subscriptions even if cleanup rejects, without classifying the generation or reaction as failed. Normal delivery paths keep their existing `close()` responsibility and fallback behavior, so cleanup does not close a session twice. The shared executor logs durable-attempt failures and authoritative provider rejection with their structured errors even when a bridge caller does not consume its outcome.
- The shared executor acquires a root-scoped delivery lock, reads durable markers, and writes `channelReactionOnlyAttempted` before calling the provider. A successful effect is confirmed with `channelReactionOnlyDelivered` and `channelOutboundSent`; an authoritative Feishu business rejection is recorded with `channelReactionOnlyError`. Response loss, transport failure, or a confirmation-write failure leaves an ambiguous attempt. Delivered, failed, and ambiguous attempts never dispatch the reaction automatically again, and an ambiguous response does not append an ERROR reaction that could coexist with an already-applied acknowledgement.
- Metadata-update events carrying an attempt or resolved marker are filtered before the outbound bridge acquires its non-reentrant message lock. The original delivery can be awaiting publication of that same update; acquiring the lock first would create a self-deadlock.
- The intent-closing loop job respects cancellation during collection and execution. A paused or errored assistant is not rewritten into a successful terminal.
- The new marker is optional assistant metadata, with no persisted schema or key-layout change. Existing delivered and failed markers remain retry guards; absent attempt metadata does not imply that a historical external effect succeeded.

## Alternatives considered

**Use any intent in the root as the delivery choice for every terminal** loses later steer or continuation answers. Root-level markers guard provider effects; they do not classify another assistant's content.

**Treat a resolved root as having no reaction intent** lets a repeated intent-bearing terminal fall through to ordinary text, cards, or attachments. Classification and retry admission are separate checks.

**Use the inbox drain's returned assistant and compensate the original root afterward** can deliver another root's text through the wrong streaming session and leak the original reaction-only root's attachments. Selecting the owned terminal and enforcing the boundary during live updates fixes both paths.

**Deliver only the foreground root's last terminal** still loses a completed ordinary answer when the same root accepts a reaction-only steer. Delivery responsibility is per terminal; selecting the root and selecting all of its newly completed terminals are separate obligations.

**Record only after the provider effect, then retry a missing confirmation** duplicates externally successful reactions after a failed local write. A durable pre-dispatch attempt instead trades automatic recovery of uncertain delivery for at-most-once effects.

**Retry ambiguous attempts with a new provider request** is unsafe without a provider idempotency key or authoritative reconciliation API. An uncertain attempt requires explicit operator reconciliation; the runtime does not infer failure from absent confirmation.

**Call `close(undefined, false)` to mean no delivery** still materializes cached Feishu answer text and can send it as a fallback after CardKit failure or an oversized render. Resource finalization therefore has an explicit no-delivery operation; omitting final text is not a delivery policy.

## Consequences

Reaction-only turns remain exclusive across foreground, queued, recovered, and compensating delivery, while ordinary answers are preserved in either order with reaction-only steers. Real Session and Storage regressions cover repeated intents, continuation after delivered and failed outcomes, confirmation-write failure, response loss after remote application, metadata-event re-entry, paused closure, queued-root failure, multi-root compensation, and post-invoke history failure on a configured streaming account. History-failure coverage uses real Feishu cards with only network fakes to verify no cached-text fallback after rejected settings, oversized content, or a terminal CardKit failure; cleanup is single-flight, foreground ownership and subscriptions are released, and no ordinary reply or reaction error flip occurs. Already-streamed progress is not retracted by cleanup.

A crash between recording an attempt and dispatch can leave an undelivered but ambiguous turn. This is an explicit at-most-once trade-off, not an exactly-once delivery guarantee. Provider calls and metadata writes remain outside retryable SQL callbacks. The feature's account gate, non-streaming restriction, target identity, and curated emoji vocabulary are unchanged.
