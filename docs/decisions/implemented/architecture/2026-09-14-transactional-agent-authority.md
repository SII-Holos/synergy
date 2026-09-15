# Decision Record: Transactional Agent Authority

Status: implemented

## Problem

Individually atomic JSON file replacement cannot commit a Session mutation with its message, indexes and notifications. Concurrent read-modify-write operations can lose updates, interrupted operations can expose partial aggregates, and directory resolution makes Agent authority depend on a particular execution filesystem. Existing installations also contain historical owner schemas, Git snapshots, artifact bytes and data from optional packages that must survive an upgrade.

## Decision

The Runtime owns an explicit Storage Handle containing a transactional logical-record store and an independent artifact location. SQLite is the default implementation; PostgreSQL uses the same contract. One Runtime owns each namespace, with revision checks, idempotent command receipts, consistent read snapshots and a durable notification outbox. Runtime concurrency spans Sessions; this change does not introduce active-active Runtime replicas.

Business transactions include their projections and notification intents. Cache updates and publication follow commit. Synchronous writes inside a business transaction bypass the streaming retry buffer: replaying one failed part outside its owning transaction could reconstruct rolled-back content when a delivery retries. Streaming work for that part must drain before the transaction begins. Rollout retains its application evidence journal, including its separate evidence/allocation and projection/head commits. Files commit before their database references. Session import/fork stages unpublished identities, deletion records cleanup work, and plugin installation retains a recoverable intent for its database/configuration/directory boundary.

Bootstrap seals an immutable original-byte backup and independently readable inventory before importing JSON. Import checkpoints, domain migration ledgers, unknown owner fields and quarantine records are retained. Import validates the stable historical Session identity, title and timestamps before migrations traverse them; the full current schema cannot serve as an import gate because released schemas and unloaded owner fields must remain valid. Activation leaves one SQL authority. Pack/merge/move export logical records and retain artifacts separately. Record roots carrying grants, consent and trust decisions never cross homes through an untrusted merge or convenience import; only same-home relocation carries them. Conflicting Session IDs preserve the target aggregate and retain the skipped source evidence. Target switching uses a durable intent and verified archive rather than two uncoordinated confi…

SQLite executes in a subprocess with bounded IPC and explicit shutdown. Its POSIX process group is separate from the Agent owner: real Docker cancellation showed that inheriting the group kills storage before terminal evidence and accounting can commit. Explicit close and parent-disconnection cleanup retain ownership without blocking cancellation. Bun 1.3.14 worker-thread tests exposed a persistence-await deadlock, so database isolation uses the same supported process mechanism as other runtime workers. macOS executables and independent module archives carry a checksum-pinned SQLite 3.51.3 engine, with a packed-artifact smoke that masks machine-wide libraries; Linux and Windows validate their embedded SQLite version at initialization. The engine requirement follows the [SQLite WAL reset fix](https://www.sqlite.org/wal.html); durability follows the [synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous). PostgreSQL isolation and ownership follow its [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) and [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) contracts.

## Alternatives considered

**Keep JSON and add more per-file locks.** This preserves inspectable files but cannot atomically commit cross-record invariants, support engine-independent snapshots or solve commit uncertainty. Locks also tie ownership to physical paths.

**Require PostgreSQL for every installation.** PostgreSQL is a useful service deployment option, but requiring a separate database service for a desktop or local CLI is unnecessary. A shared contract with SQLite keeps both deployment forms first-class.

**Mirror every SQL change back to JSON.** A permanent mirror introduces a second authority, synchronization failures and ambiguous downgrade semantics. Original backups and explicit portable exports provide recoverability without another live write path.

**Wrap all execution in a database transaction.** Filesystem operations, plugin reloads and provider requests cannot be rolled back by SQL. Long transactions also monopolize the SQLite writer and can replay external effects during retries. Durable intents and narrowly defined commit boundaries preserve evidence and recovery instead.

## Consequences

The architecture can embed Agent storage without a project directory controlling record resolution. Transactions make canonical updates and their projections reviewable as one operation; SQLite and PostgreSQL share behavior and CI coverage. The cost is explicit Handle ownership, staged file operations, migration inventory, engine packaging and additional recovery paths.

A PostgreSQL connection is not automatic high availability. Namespace ownership must be recovered deliberately after an unclean owner exit, and ambiguous external actions remain ambiguous. Portable transfer and immutable backups consume extra disk space. Downgrade requires a separate restored Home and does not include changes made after the historical snapshot. These boundaries are documented in [Agent storage](../../../architecture/agent-storage.md) and the [upgrade procedure](../../../migrations/transactional-agent-storage.md).

Storage maintenance command tests execute real bootstrap, migration and read-only inspection with the shared isolation preload. They cannot borrow the harness preload's installed Handle, because maintenance correctly refuses an active Runtime. Both test orchestrators select the same fresh composition and attribute coverage to the original source package. Only the erased SQL type contract and the separately tested IPC worker require exact-file coverage exemptions; command behavior remains measured.
