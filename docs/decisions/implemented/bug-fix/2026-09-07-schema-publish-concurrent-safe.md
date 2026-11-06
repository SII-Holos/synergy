# Decision Record: Startup schema publish is concurrency-safe

Status: implemented

## Problem

Every process boot copies the bundled `config.schema.json` into the Synergy home with an unconditional `fs.copyFile` onto the destination path. Two processes starting into the same home — a server racing another before the daemon lock is consulted, a CLI alongside a running server, or the lock-worker test fleet — issue overlapping copyfile calls onto the same destination. On Windows the loser dies with `EBUSY: resource busy or locked` (errno -16) at module load, before any application code runs; on POSIX the race is silent, so every local run reproduced nothing while Windows CI failed.

The bug hid behind test-harness timeouts for days: the 2026-09-06 Windows CI failures reported missing lock workers (15/16 to 23/24 ready at deadline) and read as slow process startup, until PR #1332's crash fast-fail reported the workers' exit codes and exposed `EBUSY` as the cause in one run — the missing workers had crashed, not stalled.

## Decision

The boot-time schema sync in `packages/harness/src/global/index.ts` now:

1. reads the bundled schema and skips all writing when the destination already holds identical contents (the common second-boot path becomes a no-op read outside any lock);
2. otherwise serializes under the schema file lock (`withFileLock` on `schema/.locks/config-schema`, introduced by the shared file-snapshot-storage work) and re-checks the destination inside the lock, so a concurrent publisher's finished work short-circuits instead of rewriting;
3. publishes through a unique `${configSchema}.${uuid}.tmp` sibling and a same-volume `rename` (atomic replace — readers never observe a partial file); because publishers are serialized, a failing rename propagates as a real error instead of being swallowed as a lost race;
4. removes the temp file in a `finally` on every path.

## Alternatives considered

- **Retry the copyfile on `EBUSY`.** Rejected: a bounded retry still races and converts a deterministic collision into a probabilistic one; the failure would resurface under heavier load with a worse signature.
- **Copy only when the destination is missing.** Rejected: the copy exists to keep the schema in sync with the installed version, so upgrades must overwrite.
- **Move the copy behind the daemon lock.** Rejected: the publish happens at module load in every process — servers, CLI commands, and test workers — and the daemon lock is acquired only later by the server path; reaching the lock manager from this module would invert the dependency and serialize all bootstraps.
- **Write directly to the destination with an exclusive flag.** Rejected: a partial copy visible to a concurrent reader is the same class of bug the lock file already fought (postmortem 0006's publish discipline); rename publishes atomically.

## Consequences

Bought: concurrent startups into one home no longer crash on Windows, the identical-content fast path makes routine boots a no-op outside any lock, and the schema file is never observed half-written. The regression test (`test/global/schema-publish.test.ts`, in the Windows CI step) races four fresh processes per home and asserts uniform exit 0 with the bundled contents published — on the pre-fix code it fails on Windows with `EBUSY` and passes everywhere after the fix. Cost: one extra read of the bundled schema per boot, and a publisher that finds the work already done inside the lock performs one extra destination read; a Windows process holding the schema file open across a version upgrade still fails startup as before — that pre-existing edge now fails at the rename with destination contents available for diagnosis.
