# Agent Storage

## Authority and ownership

`Storage.Handle` binds one `TransactionalStore` namespace and one artifact directory. Logical keys do not resolve through the current project directory. The Runtime owns the Handle, runs migrations and recovery before admission, drains outstanding writes during shutdown, and closes only Handles it opened. An embedding caller can supply a Handle and retain responsibility for its lifetime. Scope and Session identify logical ownership; Workspace files and execution environments do not own Agent records.

SQLite is the default backend. PostgreSQL is an explicit deployment choice using the same transaction, revision, pagination, receipt and outbox contract. One Runtime owns a namespace. PostgreSQL advisory ownership and a namespace owner identity fence stale writers; ordinary transactions are serialized inside that owner. Multiple sessions can run concurrently, but automatic Runtime failover and simultaneous replicas writing one namespace are not supported.

## Records and transactions

The SQL schema stores independently addressable records with keys, revisions and indexed kind, Scope, Session, Message and ordering columns. Session metadata, message info and individual parts remain separate records. Relational identity checks and domain schemas complement the generic storage contract. Unknown fields owned by unloaded packages survive persistence, upgrades and portable exports.

`Storage.transaction()` is the business boundary. Nested domain writes join the caller's transaction; readers inside it see their own writes, while external readers see a committed snapshot. Derived indexes and durable notifications commit with their canonical mutation. A failed SQL statement poisons the transaction even if a caller catches its exception. Compare-and-swap uses expected revisions, and deletion leaves a revision tombstone so a delayed writer cannot treat an old revision as a new record.

Commands that may be retried can supply an operation ID and request hash. The receipt and mutation commit together. Reusing the ID with identical input returns the committed result; different input conflicts. A lost commit response is explicitly uncertain and must be reconciled through the receipt. Database serialization failures can retry a transaction whose callback contains only database operations and deferred effects. Network requests, tool execution, plugin reloads and filesystem mutations stay outside retryable callbacks.

Inbox message publication, delivery receipts and queue removal commit together for task, steer and context inputs. Invalid attachments retain a failed queue item for repair instead of deleting its payload. BlueprintLoop transitions commit their Note lifecycle projection and Session bindings together; user-edit plugin hooks remain outside that transaction.

## Files and evidence

Large content remains in artifact storage. Writers flush bytes before publishing a database reference; artifact references include byte bounds, completeness and hashes. A database transaction cannot atomically commit a filesystem rename or an external provider request. Session imports and forks therefore stage unpublished identities, retain their evidence, and publish all Session records and indexes in the final transaction. Startup removes interrupted unpublished jobs. Deletion commits canonical removal and a cleanup record before releasing Git references and physical files.

Rollout's application journal is distinct from the database WAL. The first transaction allocates a journal sequence and records evidence; the second applies the projection and advances the committed head. Recovery projects committed evidence without repeating the tool or provider request. Historical missing sequences remain explicit gaps. Database rollback does not erase previously committed observations.

Plugin installation has a durable recovery intent and a private snapshot of the affected registration, approval, configuration and directory promotion. SQL metadata changes commit together; reload runs afterward. Interrupted installations reconcile before plugin startup. Completed installation cleanup can resume without replaying the installation or its hooks.

## Streaming and notifications

Streaming part writes coalesce for 500 ms. Terminal writes wait for prior in-flight writes; drain boundaries include timer-triggered writes and propagate persistence failures. Buffered values and caches belong to the Storage Handle. Part persistence verifies the owning Session and Message and rejects a deleted part, preventing late writes from resurrecting removed data.

State notifications enter a durable SQL outbox in the business transaction. Publication and cache changes happen after commit. An observer failure cannot roll back an already committed mutation. A new Runtime changes the frontend event epoch and reconciles outstanding notifications by requiring a fresh snapshot; it does not replay arbitrary subscribers that might perform external actions. Stream deltas remain provisional until their persistence boundary completes.

## Engines and limits

SQLite runs in a dedicated Bun subprocess, keeping synchronous SQL off the Control Plane event loop. It uses WAL, `synchronous=FULL`, separate read and write connections, bounded admission, IPC byte limits, operation deadlines and explicit child drainage. macOS packages include a checksum-verified SQLite engine; initialization rejects versions without the WAL reset fix. See the [SQLite WAL documentation](https://www.sqlite.org/wal.html) and [synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous).

PostgreSQL keeps its advisory ownership connection in a separate single-connection pool; loss of that connection permanently fences the Handle. SQLSTATE-based serialization retries are bounded to three attempts. PostgreSQL uses Bun's native SQL driver, `SERIALIZABLE` writes, `REPEATABLE READ READ ONLY` snapshots, synchronous commit, connection limits and statement/lock deadlines. PostgreSQL 16, 17 and 18 run the same contract suite in CI. Isolation does not make external side effects transactional; see [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) and [advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html).

## Upgrade and movement

Home ownership excludes the running legacy writer. Bootstrap backs up original bytes, hashes an independently readable inventory, imports records with resumable checkpoints, runs registered owner migrations, validates relationships and activates the new authority. Malformed historical Session data is preserved and quarantined with a persistent execution block. Permission, I/O, identity or backup-integrity failures stop activation. Once active, normal code has one SQL record path; reappearing legacy authority files cause startup to fail rather than silently selecting a dataset.

Portable data contains records, revisions, command receipts and pending events with a checksum footer. Pack, merge and move use this logical representation and separately preserve artifact bytes and Git objects; they do not copy a live SQLite database or assume PostgreSQL data resides in the Home. A conflicting Session ID keeps the target aggregate intact, including its artifacts and snapshot references. Skipped source data and a transfer report remain available even when move removes the original Home. Session indexes are rebuilt in the import transaction.

A target switch first saves a verified portable archive and a durable switch intent. Import is idempotent, verification precedes activation, and the intent blocks normal startup until both configuration and dataset identity agree. `data storage resume` completes an interrupted switch. Storage configuration cannot be hot-reloaded. Downgrade uses the immutable pre-upgrade backup in a separate Home; there is no reverse writer or live JSON mirror.

See [storage and paths](../reference/storage-and-paths.md) for locations and [transactional storage migration](../migrations/transactional-agent-storage.md) for operational recovery.

## Reproducible validation

`bun packages/harness/script/benchmark-storage.ts` measures 1,000 transactions with two records each, a 1 KiB payload, 32 concurrent callers and a 100-record page read. A local macOS run with Bun 1.3.14 and PostgreSQL 16 in Docker measured SQLite at 1,186 transactions/s (queued p95 31.76 ms, page read 1.50 ms) and PostgreSQL at 134 transactions/s (queued p95 236.98 ms, page read 1.91 ms). The run shared the host with build/test processes. These are reproducible development measurements, not production capacity guarantees or a comparison against the old JSON writer. PostgreSQL throughput currently includes namespace serialization and ownership checks.

Historical upgrade fixtures reconstruct the published v1.2.33, v2.4.4 and v3.0.22 writer formats with their exact source commits. See the [fixture provenance](../../packages/harness/test/storage/fixtures/README.md). Fault tests cover worker crashes, owner loss, rollback, stale revisions, ambiguous commit receipts, malformed legacy records, interrupted target activation, unpublished Session recovery and plugin installation recovery.
