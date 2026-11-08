# Decision Record: Persist organization command intake with native Inbox effects

Status: implemented

## Problem

A signed service admission does not prove that a Runtime accepted input. A lost response can prompt another attempt, and an expired or skipped attempt can arrive after a newer command. An attempt-level tombstone alone either permits duplicate effects or permanently rejects a legitimate retry. Receipt persistence outside the Inbox transaction can also report input that was never queued.

## Decision

The internal Runtime receiver owns one outer Agent-storage transaction for logical request identity, terminal attempt, accepted effect, Runtime intake sequence, Session command watermark, native Inbox delivery and notification. It validates the service signature and full input digest, then checks canonical binding and execution fences in that transaction. It captures actor and input before asynchronous verification. The driver commit guard rejects a lost connection or an expired accepting permit; expiry rolls back before recording a separate rejected attempt.

Logical identity includes organization, actor subject and request ID. Its immutable metadata binds the complete target, operation and payload digest. The accepted record preserves the first real effect, independently of each attempt's outcome. A signed skip has a separate cryptographic domain, references the original command and uses a current connection and bounded time window. It serializes with delivery and closes only an ordered slot. A rejected gap requires explicit reconciliation; receiving its frame later cannot execute it.

The receiver uses native Inbox delivery within its receipt transaction. It does not acquire the delivery-specific deduplication lock below the writer, create another scheduler, call models or activate organization resources. Its versioned metadata records live in an owner namespace outside transfer-frozen Session content, so a rejected in-flight command can retain its outcome. There is no TTL eviction of request identity.

## Alternatives considered

**One tombstone per logical request, including rejection.** This would prevent an expired attempt from being reauthorized. Only the accepted effect has logical uniqueness; terminal attempts retain independent evidence.

**Retry through Inbox deduplication alone.** Inbox identity does not validate the target, signed attempt, sequence or skipped slot. Taking its delivery lock after acquiring the SQL writer would also invert the existing lock order.

**Advance missing sequences on reconnect.** Missing evidence does not prove a command was unsent. The explicit signed skip races with a late frame under the same writer and leaves a durable result.

## Consequences

Real SQLite tests exercise simultaneous retries, restart, all native input modes, fixed attribution, changed-target conflicts, removed inputs, skip/late-frame races, transfer/archive fences and rollback after actual staged writes. Connection loss and deadline crossing leave no input or notification. Protocol tests cover complete target/body digests, UTF-8 bounds and signature-domain separation.

This owner accepts bounded text input internally. Bridge forwarding, service authorization, Session creation and controls, attachment staging, local offline admission, execution grants, transfer adapters and lifecycle cleanup remain owning integrations; these receipt primitives do not enable those product flows. Retained metadata grows with attempts until explicit lifecycle cleanup. The [organization architecture](../../../architecture/organization.md#runtime-command-intake) defines the receiver's current behavior.
