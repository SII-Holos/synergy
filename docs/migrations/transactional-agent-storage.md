# Transactional Agent Storage Upgrade

## Upgrade

Stop the instance through its normal user-facing shutdown flow before running offline maintenance. The next Runtime startup, or `synergy data storage resume`, acquires exclusive Home ownership, backs up original data and configuration, imports legacy records, runs the installed domain migrations and activates SQL authority. Never run an old binary against an activated Home.

The immutable backup is `data/storage/backups/<backup-id>/`. Version 2 uses bounded `chunks/` and `groups/` files plus a sealed `manifest.json`. Each group stores a compressed path/hash inventory and independently raw/gzip encoded original file bytes; files larger than 2 MiB receive a streamed raw chunk. Group descriptors publish only after chunk durability, and the manifest seals their checksum, counts and source identity. Configuration and plugin installation metadata use `@home/` paths inside the inventory. Workspace symbolic links are preserved as links and never traversed. Authoritative record links are rejected.

An interrupted version 1 import keeps its version 1 importer and backup: `inventory.ndjson` plus original files under `data/`. After that import, the registered `20260916-packed-artifacts-v2` migration packs loose Rollout binary evidence using a separate artifact-only backup. New imports prepare SQL records and binary locators together with bounded batch checkpoints. The backup remains independently readable without the SQL database.

Before copying, bootstrap budgets the uncompressed backup plus path metadata and group allocation, SQL records and locators, journal growth, domain migrations and a recovery reserve. SQL overhead allowances are conservative planning estimates, not measured ceilings; retained originals receive no early-deletion credit. Capacity is checked again before backup chunks and import batches. Raw backup chunks shared with canonical artifacts count once on the same filesystem; cross-filesystem copies need their own space. Corrupt global Scope or migration-ledger records block activation even on repeated resume.

Repeated `resume` uses recorded checkpoints and the same sealed backup. It rejects changed source files, missing backup bytes and identity mismatches. A record with invalid historical JSON is preserved in the backup and assigned a persistent recovery issue. Affected Sessions cannot execute until their evidence is repaired and their block is resolved. Do not delete a recovery marker merely to bypass a failed upgrade.

Activation retires originals only after re-checking every byte count and complete content digest against the sealed inventory. Backup verification is also complete; a mismatch fails activation and leaves the affected original in place. Resumed retirement tolerates originals already removed after successful verification.

## Verify and troubleshoot

`data storage status` reports the active backend, namespace, database/artifact identity, recovery records and outstanding notifications. `data storage verify` reads database integrity, record relationships and all referenced artifact bytes without modifying authority and returns a failing exit code for reported issues. Storage I/O, authorization, ownership and malformed engine/configuration errors remain fatal rather than becoming empty data.

If an upgrade is interrupted, preserve the entire Home, correct the reported cause and run `resume`. If an old JSON writer reappears after activation, preserve both datasets and stop that writer before reconciling records. Never overwrite the SQL database with an old copy or delete the manifest to force a fresh installation.

An interrupted target switch retains `data/storage/switch.json` and its checksummed transfer archive. Normal startup is blocked until `resume` verifies the target and completes activation. Restore missing connection credentials through the named environment variable; do not put credentials into a shared diagnostic report.

## Downgrade

There is no SQL-to-legacy live writer. For a sealed version 2 Home backup, run `synergy data storage restore-backup <backup> <new-home-directory>`. Restoration validates every chunk and the final inventory in a staging directory before publication; the destination must not exist. It recreates data, configuration and plugin metadata without opening SQL. Use an appropriate old release only against this separate Home. Post-upgrade changes are not part of the historical backup.

For version 1, reconstruct `data/` from the backup, restore `data/@home/config/` to the Home's `config/`, and restore `data/@home/plugin.lock` to the Home root. Validate all inventory hashes before starting the old release. The version 2 restore command deliberately rejects version 1 and artifact-only backups.

## Deferred session import

Set `SYNERGY_STORAGE_COMPAT_DEFER=1` before the first SQL bootstrap to opt into the named manifest boundary. The complete backup is still sealed before activation. The packed importer initially leaves Session aggregates on disk and records their ownership in SQL.

Deferral is conservative: any pending domain migration first stages every unresolved aggregate into SQL and then uses the central migration runner. A migration failure preserves originals and blocks touch imports. Startup imports non-archived Sessions before recovery. Only an already-current archived cohort can remain deferred after activation; a future upgrade with pending migrations stages that cohort first.

Touch and endpoint delivery import an aggregate before querying its indexes. Record batches are bounded, binary files are copied without whole-file buffering, and all recognized source hashes and target artifacts are verified before retirement. Unknown auxiliary files are preserved. Missing or malformed Session data is quarantined; storage and I/O errors remain retryable. Pending listing projections never enter persisted indexes.

The Runtime imports a bounded number of pending aggregates per tick. Create `data/storage/compat-pause` to hold background import between ticks; remove it to resume. Shutdown stops and drains the ticker. This mode does not promise a particular startup speedup, and ordinary storage status output does not yet include convergence counts.

Pack, merge, move and storage-target migration reject pending or quarantined aggregates. Let background import converge and repair quarantined evidence before transferring the Home. The sealed backup contains pre-upgrade state; it does not capture changes made after SQL activation. An official downgrade therefore restores the backup into a separate Home.

## Transfer

Use `data pack` for a portable logical backup, and `data merge` or `data move` to restore or combine data. Agent records, revisions and operation receipts move independently of the engine; Git objects and artifacts move with their references. Grants, consent and trust records (plugin approvals, permissions, registry) are refused from another home's archive during `data merge` and only travel with `data move`. A target Session ID wins as a whole aggregate. The retained source snapshot and transfer report let an operator recover skipped content even after `move --remove-original`.
