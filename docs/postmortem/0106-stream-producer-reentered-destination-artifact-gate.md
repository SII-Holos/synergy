# Stream producer reentered its destination artifact gate

## Executive summary

The real two-Home handoff receiver stalled while importing a content chunk. Destination binary preparation owned the artifact gate and asked its producer for bytes; that producer needed the same Store's object cache, which queued behind the held gate.

## Summary

The failure used isolated temporary Homes and real Storage, source freezing, object delivery and private target staging. It did not involve the user's active Runtime or data. Increasing a timeout or replacing target reads with direct source bytes would have hidden the composition error and its ownership boundary.

## Timeline

1. A real source package sealed and its target fetched the root and metadata pages.
2. The target stalled on the first content read inside `prepareBinaryStream()`.
3. A lower-level fixture reproduced the same cycle using a retained binary reader in its own Store. A bounded rescue cancelled the waiter and allowed cleanup.
4. Producer consumption moved to a private bounded spool outside the artifact gate; canonical backend preparation and pinning remained inside it.
5. The actual receiver completed within its original test deadline. Additional counterexamples verified inherited cancellation before consumption, mutation of the selected key and corruption of the private spool.
6. Independent review found that freeing the artifact gate also removed its old admission bound. A real seventeenth producer consumed input, and Runtime shutdown closed the backend before held producers finished. Runtime-wide admission and complete preparation tracking corrected both counterexamples without holding the artifact gate during producer work.

## Root cause

The owner treated a caller-supplied iterable as passive bytes. It could actually perform Storage reads, cache writes and finalizer work that required the destination's non-reentrant artifact gate. The corresponding pin invariant was valid, but its critical section began before the owner controlled the input.

## Guardrails

- [x] Machine check: `test/storage/artifact-stream-producer.test.ts` — `bounded producer admission queues before opening another private spool`.

`test/storage/artifact-stream-producer.test.ts` uses real same-Store retained-byte reads, collection, cancellation, iterator cleanup, key mutation and private spool corruption. Existing local streams, prepared receipt evidence and object suites preserve canonical ownership and uncertain-commit retention. The organization Runtime's two-Home receiver fixture checks the actual composition, private target visibility and fail-closed cache corruption. See [the decision](../decisions/implemented/bug-fix/2026-11-12-spool-producers-before-artifact-adoption.md).

## Lessons

Consume caller-controlled producers before entering the physical owner's exclusive section. Releasing that section requires a separate bounded preparation phase; it must not move immutable publication ahead of its native pin or invent a second codec and retention path.
