# Decision Record: Drain admitted rollout writes before cancellation completes

Status: implemented

## Problem

A timeout could close a transport artifact while an upstream read or checkpoint was still in flight. A later chunk then failed persistence, turning ordinary cancellation into a recording failure. Scope cleanup could also run outside the context that created its resources.

## Decision

Transport cancellation stops upstream reading, joins the admitted pull, persists its received prefix and only then closes the body and attempt. Closing and recorder completion share a completion promise. Call completion joins both artifact appends and ledger checkpoints. Artifact writers continue to reject writes after close; storage failures remain authoritative.

State disposal binds the resource's creation context and joins the same entry cleanup across reset and disposal callers. Entries are removed after their cleanup completes.

## Alternatives considered

**Ignore writes after close.** This loses received bytes and incorrectly certifies incomplete evidence.

**Disable timeout cleanup.** This leaks upstream readers and owned resources, preventing bounded execution.

## Consequences

Cancellation waits for already admitted persistence, so orchestration must allocate a separate cleanup deadline. Missing final provider usage remains unknown. Behavioral tests hold reads and writes behind explicit barriers and assert retained prefixes and terminal ordering.

Oversized upstream chunks can retain an unconsumed tail when an abort makes `reader.cancel()` reject. Closing drains that already admitted tail even when upstream cancellation fails; a 2 MiB behavioral regression verifies the complete received prefix.
