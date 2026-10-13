# Decision Record: Turn-scoped Channel delivery

Status: implemented

## Problem

Foreground, compensation and recovered delivery classified the same terminal independently. Terminal enumeration, attachment projection and reaction admission repeatedly materialized the complete Session history. Delivery work therefore grew with unrelated historical bodies and could diverge between live and recovered replies.

## Decision

`SessionHistory.turnInfos()` and `turnMessages()` share effective root selection, chronology, rollback visibility and deletion handling. Metadata checks do not hydrate bodies. A Channel operation enumerates its own root, loads its bodies once, and shares them across terminal plans. Plans are temporary values, with no persistent cache or new storage schema.

`delivery-plan.ts` owns generation boundaries, ordinary text and error fallback, reaction intent and suppression of earlier reaction segments. `delivery.ts` executes both foreground and recovered plans. The foreground supplies only its streaming close and status-reaction operations. Root locks guard a fresh authoritative metadata check before provider effects; deleted or rolled-back terminals cannot be revived from a retained plan. Attachment URLs and response cards retain their existing durable ownership records.

Reaction delivery keeps the existing persist-attempt, send, confirm sequence and [uncertain-outcome policy](../bug-fix/2026-10-10-reaction-only-delivery-ownership.md). Network requests never run in a storage transaction. Successful foreground text is marked before auxiliary delivery, so an attachment failure cannot resend it. Outbound bridge disposal and account stop cancel pending delivery reads. Foreground presentation releases its subscriptions and closes without delivery on cancellation, independently of model completion. A close already in progress is not restarted. Later registration uses the current account lifetime.

The selected Feishu component owns the tool, visibility policy and termination job through one worker-compatible registration entry point. Tool parameters remain an inline empty object supported by the existing catalog generator. Unrelated rendering, Browser, benchmark and generator changes are excluded from this feature.

## Alternatives considered

**Cache full Session history across deliveries** adds another invalidation owner and risks stale attempt markers. Operation-local target-root bodies and fresh metadata checks bound the work without a long-lived cache.

**Optimize each delivery path separately** leaves terminal classification, failure behavior and attachment boundaries duplicated. One planner and executor preserves a single contract for ordinary and reaction terminals.

**Hydrate the selected terminal alone** loses earlier tools, attachments and no-answer fallback from the same generation. The whole target turn is read once and segmented canonically.

## Consequences

Work-count tests use real storage with 500 and 5,000 unrelated historical messages, three terminals, and more than 2,000 Parts in one terminal. Enumeration and duplicate checks read zero bodies; all three deliveries share four target-message body reads. Cancellation, deletion, rollback, concurrent reaction attempts and bridge disposal are tested separately from model context work. A fresh Runtime reopens the same database after an ambiguous send, skips repeated terminal events without body reads, and still delivers a new ordinary root. Disposing that bridge leaves no delivery subscription processing later events.

Real component/worker and model-loop fixtures replace only inference and external network behavior. They cover tool termination, ordinary and reaction replies in both orders, queued roots, ambiguous outcomes, metadata re-entry and no-delivery cleanup. The account feature remains disabled by default, unavailable on streaming or disabled accounts and Boss explicit-delivery sessions, and cannot let the model choose an emoji.
