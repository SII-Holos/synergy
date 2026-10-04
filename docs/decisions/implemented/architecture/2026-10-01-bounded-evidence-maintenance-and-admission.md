# Decision Record: Bounded evidence maintenance and durable input admission

Status: implemented

## Problem

Enumerating retention owners over the complete evidence table occupies the storage reader in large installations. An input response can also precede its durable Inbox record, and a response chunk publishes its locator and journal through separate transactions.

## Decision

SQLite owns one writer and independent foreground and maintenance reader workers. Maintenance reads use the background lane and release their snapshot after each bounded batch. The storage-owned evidence owner projection maintains record counts, timestamps and generations in the canonical transaction; resumable historical preparation excludes unfinished owners from retention. Store initialization creates the structure and durable preparation marker before scheduling background work. The registered startup migration records this structural readiness without joining a historical batch, whose background admission deadline can expire independently of startup.

Inbox insertion and navigation activity commit together before acknowledgement. A separate lightweight run shell follows durable Inbox admission, preserving concurrent cancellation visibility. Idle passive inputs enter the durable Inbox with their existing message identity before acknowledgement. The Session manager materializes them without opening an LLM turn or clearing a pause. Their transient execution owner identifies passive materialization, so an overlapping passive input retains its recovery admission instead of becoming an unconsumed steer. Model-work discovery excludes passive-only records while recovery discovery includes them. Asynchronous prompt acknowledgement waits for the same admission boundary.

Binary preparation flushes bytes before publication and pins unpublished packs. A prepared locator can join the response checkpoint's journal transaction, together with the chunk, artifact information, usage projection and head. Pins survive rollback and uncertain settlement; evidence failures still propagate.

## Alternatives considered

**A second writer.** Concurrent writer ownership would change receipt, revision and recovery guarantees. Separate reader workers remove reader contention while retaining the existing single writer.

**A full startup aggregate.** An indexed aggregate still visits all evidence rows and delays large homes. Durable bounded preparation permits admission while withholding unknown retention candidates.

**An early asynchronous acknowledgement.** Returning before the input record commits cannot tell the client when to clear its draft. Durable admission retains retries through the existing message and receipt identities.

## Consequences

Maintenance has a separate reader lifecycle and a resumable derived projection. Historical owners become retention candidates only after their source generation is verified. Prepared binary tokens add a narrowly owned resource lifetime, and bytes from an aborted transaction can remain recoverable orphans until ordinary collection. SQLite's snapshot behavior follows its [WAL documentation](https://www.sqlite.org/wal.html); projection mutations use the engine's [transactional triggers](https://www.sqlite.org/lang_createtrigger.html). PostgreSQL retains the common transaction, receipt and outbox semantics.

Owner recounts require the existing Session index after a large-data experiment found the Message index scanning unrelated owners with the same fourth key segment. This is an explicit schema regression constraint under [SQLite INDEXED BY semantics](https://www.sqlite.org/lang_indexedby.html), scoped to SQLite; deleting that index causes preparation to fail instead of silently restoring the unbounded scan.
