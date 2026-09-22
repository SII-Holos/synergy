# Decision Record: Workspace identity and local bindings

Status: implemented

## Problem

A directory string cannot identify working files independently of their location. Concurrent registration, moving a directory, importing another host's history, and reusing a former pathname require distinct outcomes.

## Decision

The Harness Workspace catalog owns stable identities and transactional location indexes. Each local binding names a host namespace, path, optional filesystem identity, and generation. Rebinding requires the expected record revision, preserves the Workspace ID, and advances its binding generation. A conflicting destination or replaced directory requires an explicit operation instead of silently adopting different files. Cross-Scope lookup is unavailable to callers.

Runtime hosts explicitly supply local location identification. Runtime Local uses a persistent private namespace identity and filesystem directory identities; hosts without local file capabilities can omit that dependency. A record revision orders metadata changes, while a binding generation invalidates work resolved against a previous location.

Sessions persist a nullable Workspace ID and hydrate public directory descriptors through the catalog. On-access owner migrations apply before navigation validation, with a new derived-index repair for already-completed historical index migrations. The Runtime initializes its namespace outside retryable storage transactions. Hosts without filesystem capabilities preserve historical bindings as unbound records.

Transcript and Rollout exports include the referenced catalog records. Imports retain their historical locations but mark bindings unbound and discard shared-write grants. If the original identity is already bound locally, import creates a separate historical identity so an uploaded transcript cannot authorize file access.

## Alternatives considered

Deriving Workspace IDs from absolute paths would change identity on a move and conflate equal paths on different hosts. Keeping a path in every Session would leave multiple mutable owners of the same binding. Neither supports an atomic destination uniqueness check.

## Consequences

Working-file resources are keyed by Runtime, Workspace ID and binding generation. The startup registry declares Scope or Workspace ownership, and Scope steps cannot depend on Workspace steps. Configuration subscriptions keep their Scope owner. Native file notifications, formatter subscriptions and VCS notifications carry and filter Workspace identity, while the Scope bus retains its event sequence.

LSP process recovery verifies host, owner process identity and child process identity before signaling an orphan. Concurrent registrations use one locked, atomic process ledger; per-client release tokens prevent an earlier client from removing another record. PID-only historical files cannot establish authority to signal a process. Starting another Workspace must leave active language servers alive.

Local bindings and their indexes are persisted separately from Session history. Consumers must resolve an explicit Workspace and retain its generation for execution. A directory that is missing or has been replaced cannot be made usable merely by finding another directory at the stored pathname.

## Verification

Resource tests interleave Workspace startup, shared Sessions, rebinding and Scope disposal. Runtime Local tests exercise separate real Git directories, bounded file indexes, native watcher delivery, nested Workspace paths and whitespace in filenames. Formatter tests launch real subprocesses and verify one execution per edit across multiple Workspace subscriptions.

Catalog tests exercise concurrent registration, host separation, generation rejection, cross-Scope lookup, and stale conditional updates against real SQLite. Filesystem tests verify persistent namespace convergence and directory replacement with real temporary directories.

Session tests cover shared parent/child references, rebinding, null workspaces, canonical writes, unbound transcript imports, Rollout archives, unknown owner data, old metadata, navigation repair after restart, deferred-owner isolation and transaction rollback. Runtime Local tests remove a historical directory before reopening and verify that metadata remains readable while execution fails.
